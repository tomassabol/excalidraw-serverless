import { randomUUID } from 'node:crypto';

import { BadRequestError, NotFoundError } from '@aws-lambda-powertools/event-handler/http';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  BatchGetCommand,
  BatchWriteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type FileDownloadResult,
  type FileUploadResult,
  type Folder,
  type SaveSceneResult,
  type SceneContent,
  type SceneMeta,
  type SceneWithContent,
  type SearchResult,
  type Tag,
  TRASH_RETENTION_DAYS,
  type TrashBatch,
  type Workspace,
  type WorkspaceTree,
} from '@exs/shared';

import { ConflictError } from './lib/errors.ts';
import {
  fileKey,
  folderSk,
  META_SK,
  membershipSk,
  sceneObjectKey,
  scenePrefix,
  sceneSk,
  tagSk,
  userPk,
  wsPk,
} from './lib/keys.ts';

// -----------------------------------------------------------------------------
// Stored item shapes
// -----------------------------------------------------------------------------

interface TrashFields {
  deletedAt?: string;
  trashBatchId?: string;
  trashRoot?: boolean;
  /** Epoch seconds; DynamoDB TTL attribute. */
  expiresAt?: number;
}

interface WorkspaceItem {
  PK: string;
  SK: typeof META_SK;
  type: 'workspace';
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

interface MembershipItem {
  PK: string;
  SK: string;
  type: 'membership';
  workspaceId: string;
  role: 'owner';
  createdAt: string;
}

interface FolderItem extends TrashFields {
  PK: string;
  SK: string;
  type: 'folder';
  id: string;
  parentId: string | null;
  name: string;
  nameLower: string;
  createdAt: string;
  updatedAt: string;
}

interface SceneItem extends TrashFields {
  PK: string;
  SK: string;
  type: 'scene';
  id: string;
  folderId: string | null;
  name: string;
  nameLower: string;
  tags: string[];
  version: number;
  size: number;
  s3Key: string;
  createdAt: string;
  updatedAt: string;
}

interface TagItem {
  PK: string;
  SK: string;
  type: 'tag';
  name: string;
  color: string | null;
}

type PartitionItem = WorkspaceItem | FolderItem | SceneItem | TagItem;
type TrashableItem = FolderItem | SceneItem;

const isLive = (item: TrashFields) => item.deletedAt === undefined;
const isConditionalCheckFailed = (error: unknown) =>
  error instanceof Error &&
  (error.name === 'ConditionalCheckFailedException' ||
    (error.name === 'TransactionCanceledException' &&
      error.message.includes('ConditionalCheckFailed')));

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// -----------------------------------------------------------------------------
// Mapping
// -----------------------------------------------------------------------------

const toWorkspace = (item: WorkspaceItem): Workspace => ({
  id: item.id,
  name: item.name,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

const toFolder = (workspaceId: string, item: FolderItem): Folder => ({
  id: item.id,
  workspaceId,
  parentId: item.parentId,
  name: item.name,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

const toScene = (workspaceId: string, item: SceneItem): SceneMeta => ({
  id: item.id,
  workspaceId,
  folderId: item.folderId,
  name: item.name,
  tags: item.tags ?? [],
  version: item.version,
  size: item.size,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
});

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

export interface StoreDeps {
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
  tableName: string;
  dataBucket: string;
  now?: () => Date;
  presignExpiresInSeconds?: number;
}

export type Store = ReturnType<typeof createStore>;

/**
 * Data access for workspaces, folders, scenes, tags, trash and files.
 * Every public method takes the caller's user id and checks workspace
 * membership first; unknown or foreign workspaces are a 404.
 */
export const createStore = (deps: StoreDeps) => {
  const { ddb, s3, tableName: TableName, dataBucket: Bucket } = deps;
  const now = deps.now ?? (() => new Date());
  const presignExpiresIn = deps.presignExpiresInSeconds ?? 900;

  // ---------------------------------------------------------------- helpers

  const requireMember = async (userId: string, workspaceId: string) => {
    const { Item } = await ddb.send(
      new GetCommand({
        TableName,
        Key: { PK: userPk(userId), SK: membershipSk(workspaceId) },
      }),
    );
    if (!Item) {
      throw new NotFoundError('Workspace not found');
    }
  };

  const loadPartition = async (workspaceId: string): Promise<PartitionItem[]> => {
    const items: PartitionItem[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': wsPk(workspaceId) },
          ExclusiveStartKey,
        }),
      );
      items.push(...((page.Items ?? []) as PartitionItem[]));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  };

  const getItem = async <T>(workspaceId: string, sk: string): Promise<T | undefined> => {
    const { Item } = await ddb.send(
      new GetCommand({ TableName, Key: { PK: wsPk(workspaceId), SK: sk } }),
    );
    return Item as T | undefined;
  };

  const requireLiveFolder = async (workspaceId: string, folderId: string) => {
    const folder = await getItem<FolderItem>(workspaceId, folderSk(folderId));
    if (!folder || !isLive(folder)) {
      throw new BadRequestError('Folder not found');
    }
    return folder;
  };

  const requireLiveScene = async (workspaceId: string, sceneId: string) => {
    const scene = await getItem<SceneItem>(workspaceId, sceneSk(sceneId));
    if (!scene || !isLive(scene)) {
      throw new NotFoundError('Scene not found');
    }
    return scene;
  };

  const transactInChunks = async (
    items: NonNullable<TransactWriteCommandInput['TransactItems']>,
  ) => {
    for (const part of chunk(items, 100)) {
      await ddb.send(new TransactWriteCommand({ TransactItems: part }));
    }
  };

  const putSceneObject = async (key: string, content: SceneContent) => {
    const body = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      source: 'excalidraw-serverless',
      elements: content.elements,
      appState: content.appState,
    });
    await s3.send(
      new PutObjectCommand({
        Bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
      }),
    );
    return Buffer.byteLength(body);
  };

  const deletePrefix = async (prefix: string) => {
    let ContinuationToken: string | undefined;
    let deleted = 0;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }));
        deleted += keys.length;
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return deleted;
  };

  const objectExists = async (key: string) => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
      return true;
    } catch (error) {
      if (
        error instanceof NotFound ||
        (error instanceof S3ServiceException && error.$metadata?.httpStatusCode === 404)
      ) {
        return false;
      }
      throw error;
    }
  };

  /** Ids of a folder and all of its live descendant folders. */
  const descendantFolderIds = (folders: FolderItem[], rootId: string) => {
    const children = new Map<string | null, string[]>();
    for (const f of folders) {
      const list = children.get(f.parentId) ?? [];
      list.push(f.id);
      children.set(f.parentId, list);
    }
    const ids = new Set<string>();
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop() as string;
      if (ids.has(id)) continue;
      ids.add(id);
      stack.push(...(children.get(id) ?? []));
    }
    return ids;
  };

  const markTrashed = async (workspaceId: string, items: TrashableItem[], rootSk: string) => {
    const deletedAt = now();
    const expiresAt = Math.floor(deletedAt.getTime() / 1000) + TRASH_RETENTION_DAYS * 24 * 3600;
    const trashBatchId = randomUUID();
    await transactInChunks(
      items.map((item) => ({
        Update: {
          TableName,
          Key: { PK: wsPk(workspaceId), SK: item.SK },
          UpdateExpression: 'SET deletedAt = :d, trashBatchId = :b, trashRoot = :r, expiresAt = :e',
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
          ExpressionAttributeValues: {
            ':d': deletedAt.toISOString(),
            ':b': trashBatchId,
            ':r': item.SK === rootSk,
            ':e': expiresAt,
          },
        },
      })),
    );
    return { trashBatchId, count: items.length };
  };

  // ------------------------------------------------------------- workspaces

  const listWorkspaces = async (userId: string): Promise<Workspace[]> => {
    const memberships: MembershipItem[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :ws)',
          ExpressionAttributeValues: { ':pk': userPk(userId), ':ws': 'WS#' },
          ExclusiveStartKey,
        }),
      );
      memberships.push(...((page.Items ?? []) as MembershipItem[]));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    const workspaces: Workspace[] = [];
    for (const part of chunk(memberships, 100)) {
      let keys = part.map((m) => ({ PK: wsPk(m.workspaceId), SK: META_SK }));
      while (keys.length) {
        const res = await ddb.send(
          new BatchGetCommand({ RequestItems: { [TableName]: { Keys: keys } } }),
        );
        workspaces.push(
          ...((res.Responses?.[TableName] ?? []) as WorkspaceItem[]).map(toWorkspace),
        );
        keys = (res.UnprocessedKeys?.[TableName]?.Keys ?? []) as typeof keys;
      }
    }
    return workspaces.sort(byName);
  };

  const createWorkspace = async (userId: string, input: { name: string }): Promise<Workspace> => {
    const id = randomUUID();
    const timestamp = now().toISOString();
    const item: WorkspaceItem = {
      PK: wsPk(id),
      SK: META_SK,
      type: 'workspace',
      id,
      name: input.name,
      ownerId: userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const membership: MembershipItem = {
      PK: userPk(userId),
      SK: membershipSk(id),
      type: 'membership',
      workspaceId: id,
      role: 'owner',
      createdAt: timestamp,
    };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName, Item: membership, ConditionExpression: 'attribute_not_exists(PK)' } },
        ],
      }),
    );
    return toWorkspace(item);
  };

  const renameWorkspace = async (
    userId: string,
    workspaceId: string,
    input: { name: string },
  ): Promise<Workspace> => {
    await requireMember(userId, workspaceId);
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName,
        Key: { PK: wsPk(workspaceId), SK: META_SK },
        UpdateExpression: 'SET #name = :name, updatedAt = :u',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#name': 'name' },
        ExpressionAttributeValues: { ':name': input.name, ':u': now().toISOString() },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return toWorkspace(Attributes as WorkspaceItem);
  };

  /** Only empty workspaces (no folders, scenes or trash) can be deleted. */
  const deleteWorkspace = async (userId: string, workspaceId: string) => {
    await requireMember(userId, workspaceId);
    const items = await loadPartition(workspaceId);
    const content = items.filter((i) => i.type === 'folder' || i.type === 'scene');
    if (content.length > 0) {
      throw new ConflictError('Workspace is not empty', undefined, {
        folders: content.filter((i) => i.type === 'folder').length,
        scenes: content.filter((i) => i.type === 'scene').length,
      });
    }
    await transactInChunks([
      ...items.map((i) => ({ Delete: { TableName, Key: { PK: i.PK, SK: i.SK } } })),
      { Delete: { TableName, Key: { PK: userPk(userId), SK: membershipSk(workspaceId) } } },
    ]);
    await deletePrefix(`ws/${workspaceId}/`);
  };

  const getTree = async (userId: string, workspaceId: string): Promise<WorkspaceTree> => {
    await requireMember(userId, workspaceId);
    const items = await loadPartition(workspaceId);
    const meta = items.find((i): i is WorkspaceItem => i.type === 'workspace');
    if (!meta) {
      throw new NotFoundError('Workspace not found');
    }
    const folders = items.filter((i): i is FolderItem => i.type === 'folder' && isLive(i));
    const scenes = items.filter((i): i is SceneItem => i.type === 'scene' && isLive(i));
    const tagItems = items.filter((i): i is TagItem => i.type === 'tag');

    const counts = new Map<string, { name: string; count: number }>();
    for (const scene of scenes) {
      for (const tag of scene.tags ?? []) {
        const key = tag.toLowerCase();
        const entry = counts.get(key) ?? { name: tag, count: 0 };
        entry.count += 1;
        counts.set(key, entry);
      }
    }
    const tags: Tag[] = [];
    for (const t of tagItems) {
      const key = t.name.toLowerCase();
      tags.push({ name: t.name, color: t.color, sceneCount: counts.get(key)?.count ?? 0 });
      counts.delete(key);
    }
    for (const { name, count } of counts.values()) {
      tags.push({ name, color: null, sceneCount: count });
    }

    return {
      workspace: toWorkspace(meta),
      folders: folders.map((f) => toFolder(workspaceId, f)).sort(byName),
      scenes: scenes.map((s) => toScene(workspaceId, s)).sort(byName),
      tags: tags.sort(byName),
    };
  };

  // ---------------------------------------------------------------- folders

  const createFolder = async (
    userId: string,
    workspaceId: string,
    input: { name: string; parentId: string | null },
  ): Promise<Folder> => {
    await requireMember(userId, workspaceId);
    if (input.parentId) {
      await requireLiveFolder(workspaceId, input.parentId);
    }
    const id = randomUUID();
    const timestamp = now().toISOString();
    const item: FolderItem = {
      PK: wsPk(workspaceId),
      SK: folderSk(id),
      type: 'folder',
      id,
      parentId: input.parentId,
      name: input.name,
      nameLower: input.name.toLowerCase(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await ddb.send(
      new PutCommand({ TableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }),
    );
    return toFolder(workspaceId, item);
  };

  const updateFolder = async (
    userId: string,
    workspaceId: string,
    folderId: string,
    input: { name?: string; parentId?: string | null },
  ): Promise<Folder> => {
    await requireMember(userId, workspaceId);
    const folder = await getItem<FolderItem>(workspaceId, folderSk(folderId));
    if (!folder || !isLive(folder)) {
      throw new NotFoundError('Folder not found');
    }
    if (input.parentId) {
      if (input.parentId === folderId) {
        throw new BadRequestError('A folder cannot be its own parent');
      }
      const items = await loadPartition(workspaceId);
      const folders = items.filter((i): i is FolderItem => i.type === 'folder' && isLive(i));
      if (!folders.some((f) => f.id === input.parentId)) {
        throw new BadRequestError('Folder not found');
      }
      if (descendantFolderIds(folders, folderId).has(input.parentId)) {
        throw new BadRequestError('A folder cannot be moved into its own subfolder');
      }
    }

    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ':u': now().toISOString() };
    const sets = ['updatedAt = :u'];
    if (input.name !== undefined) {
      names['#name'] = 'name';
      values[':name'] = input.name;
      values[':nameLower'] = input.name.toLowerCase();
      sets.push('#name = :name', 'nameLower = :nameLower');
    }
    if (input.parentId !== undefined) {
      values[':parentId'] = input.parentId;
      sets.push('parentId = :parentId');
    }
    try {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName,
          Key: { PK: wsPk(workspaceId), SK: folderSk(folderId) },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
          ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toFolder(workspaceId, Attributes as FolderItem);
    } catch (error) {
      if (isConditionalCheckFailed(error)) throw new NotFoundError('Folder not found');
      throw error;
    }
  };

  /** Moves a folder, its subfolders and their scenes to the trash as one batch. */
  const trashFolder = async (userId: string, workspaceId: string, folderId: string) => {
    await requireMember(userId, workspaceId);
    const items = await loadPartition(workspaceId);
    const folders = items.filter((i): i is FolderItem => i.type === 'folder' && isLive(i));
    if (!folders.some((f) => f.id === folderId)) {
      throw new NotFoundError('Folder not found');
    }
    const folderIds = descendantFolderIds(folders, folderId);
    const scenes = items.filter(
      (i): i is SceneItem =>
        i.type === 'scene' && isLive(i) && i.folderId !== null && folderIds.has(i.folderId),
    );
    const toTrash: TrashableItem[] = [...folders.filter((f) => folderIds.has(f.id)), ...scenes];
    return markTrashed(workspaceId, toTrash, folderSk(folderId));
  };

  // ----------------------------------------------------------------- scenes

  const createScene = async (
    userId: string,
    workspaceId: string,
    input: { name: string; folderId: string | null; tags: string[]; content?: SceneContent },
  ): Promise<SceneMeta> => {
    await requireMember(userId, workspaceId);
    if (input.folderId) {
      await requireLiveFolder(workspaceId, input.folderId);
    }
    const id = randomUUID();
    const version = 1;
    const s3Key = sceneObjectKey(workspaceId, id, version);
    const size = await putSceneObject(s3Key, input.content ?? { elements: [], appState: {} });
    const timestamp = now().toISOString();
    const item: SceneItem = {
      PK: wsPk(workspaceId),
      SK: sceneSk(id),
      type: 'scene',
      id,
      folderId: input.folderId,
      name: input.name,
      nameLower: input.name.toLowerCase(),
      tags: dedupeTags(input.tags),
      version,
      size,
      s3Key,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await ddb.send(
      new PutCommand({ TableName, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }),
    );
    return toScene(workspaceId, item);
  };

  const getScene = async (
    userId: string,
    workspaceId: string,
    sceneId: string,
  ): Promise<SceneWithContent> => {
    await requireMember(userId, workspaceId);
    const scene = await requireLiveScene(workspaceId, sceneId);
    const object = await s3.send(new GetObjectCommand({ Bucket, Key: scene.s3Key }));
    const raw = JSON.parse((await object.Body?.transformToString()) ?? '{}');
    return {
      scene: toScene(workspaceId, scene),
      content: { elements: raw.elements ?? [], appState: raw.appState ?? {} },
    };
  };

  /**
   * Saves new content with optimistic concurrency. Content is written to a new
   * versioned object first and only becomes current once the conditional
   * update on `version` succeeds, so a conflicting save never overwrites the
   * current content.
   */
  const saveSceneContent = async (
    userId: string,
    workspaceId: string,
    sceneId: string,
    input: SceneContent & { baseVersion: number },
  ): Promise<SaveSceneResult & { previousSize: number }> => {
    await requireMember(userId, workspaceId);
    const scene = await requireLiveScene(workspaceId, sceneId);
    if (scene.version !== input.baseVersion) {
      throw new ConflictError('Scene was changed elsewhere', undefined, {
        currentVersion: scene.version,
      });
    }
    const version = input.baseVersion + 1;
    const s3Key = sceneObjectKey(workspaceId, sceneId, version);
    const size = await putSceneObject(s3Key, input);
    const updatedAt = now().toISOString();
    try {
      await ddb.send(
        new UpdateCommand({
          TableName,
          Key: { PK: wsPk(workspaceId), SK: sceneSk(sceneId) },
          UpdateExpression: 'SET version = :v, s3Key = :k, size = :s, updatedAt = :u',
          ConditionExpression: 'version = :base AND attribute_not_exists(deletedAt)',
          ExpressionAttributeValues: {
            ':v': version,
            ':k': s3Key,
            ':s': size,
            ':u': updatedAt,
            ':base': input.baseVersion,
          },
        }),
      );
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key: s3Key }] } }));
      const current = await getItem<SceneItem>(workspaceId, sceneSk(sceneId));
      if (!current || !isLive(current)) {
        throw new NotFoundError('Scene not found');
      }
      throw new ConflictError('Scene was changed elsewhere', undefined, {
        currentVersion: current.version,
      });
    }
    // the previous version is no longer referenced
    await s3.send(
      new DeleteObjectsCommand({
        Bucket,
        Delete: { Objects: [{ Key: scene.s3Key }], Quiet: true },
      }),
    );
    return { version, updatedAt, size, previousSize: scene.size };
  };

  const updateScene = async (
    userId: string,
    workspaceId: string,
    sceneId: string,
    input: { name?: string; folderId?: string | null; tags?: string[] },
  ): Promise<SceneMeta> => {
    await requireMember(userId, workspaceId);
    if (input.folderId) {
      await requireLiveFolder(workspaceId, input.folderId);
    }
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ':u': now().toISOString() };
    const sets = ['updatedAt = :u'];
    if (input.name !== undefined) {
      names['#name'] = 'name';
      values[':name'] = input.name;
      values[':nameLower'] = input.name.toLowerCase();
      sets.push('#name = :name', 'nameLower = :nameLower');
    }
    if (input.folderId !== undefined) {
      values[':folderId'] = input.folderId;
      sets.push('folderId = :folderId');
    }
    if (input.tags !== undefined) {
      values[':tags'] = dedupeTags(input.tags);
      sets.push('tags = :tags');
    }
    try {
      const { Attributes } = await ddb.send(
        new UpdateCommand({
          TableName,
          Key: { PK: wsPk(workspaceId), SK: sceneSk(sceneId) },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(deletedAt)',
          ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      return toScene(workspaceId, Attributes as SceneItem);
    } catch (error) {
      if (isConditionalCheckFailed(error)) throw new NotFoundError('Scene not found');
      throw error;
    }
  };

  const trashScene = async (userId: string, workspaceId: string, sceneId: string) => {
    await requireMember(userId, workspaceId);
    const scene = await requireLiveScene(workspaceId, sceneId);
    return markTrashed(workspaceId, [scene], scene.SK);
  };

  // ------------------------------------------------------------------ trash

  const trashedItems = (items: PartitionItem[]) => {
    const nowSeconds = Math.floor(now().getTime() / 1000);
    return items.filter(
      (i): i is TrashableItem =>
        (i.type === 'folder' || i.type === 'scene') &&
        !isLive(i) &&
        // TTL deletes lag; hide items that have already expired
        (i.expiresAt ?? 0) > nowSeconds,
    );
  };

  const listTrash = async (userId: string, workspaceId: string): Promise<TrashBatch[]> => {
    await requireMember(userId, workspaceId);
    const batches = new Map<string, TrashableItem[]>();
    for (const item of trashedItems(await loadPartition(workspaceId))) {
      if (!item.trashBatchId) continue;
      const list = batches.get(item.trashBatchId) ?? [];
      list.push(item);
      batches.set(item.trashBatchId, list);
    }
    const result: TrashBatch[] = [];
    for (const [batchId, list] of batches) {
      const root = list.find((i) => i.trashRoot) ?? list[0];
      if (!root?.deletedAt || root.expiresAt === undefined) continue;
      result.push({
        batchId,
        deletedAt: root.deletedAt,
        expiresAt: new Date(root.expiresAt * 1000).toISOString(),
        root: { type: root.type, id: root.id, name: root.name },
        folderCount: list.filter((i) => i.type === 'folder').length,
        sceneCount: list.filter((i) => i.type === 'scene').length,
      });
    }
    return result.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  };

  const loadBatch = async (workspaceId: string, batchId: string) => {
    const items = await loadPartition(workspaceId);
    const batch = trashedItems(items).filter((i) => i.trashBatchId === batchId);
    if (!batch.length) {
      throw new NotFoundError('Trash entry not found');
    }
    return { items, batch };
  };

  /**
   * Restores a trash batch. If the batch root's parent folder is gone (trashed
   * separately or purged), the root is restored to the workspace root.
   */
  const restoreTrash = async (userId: string, workspaceId: string, batchId: string) => {
    await requireMember(userId, workspaceId);
    const { items, batch } = await loadBatch(workspaceId, batchId);
    const liveFolderIds = new Set(
      items.filter((i) => i.type === 'folder' && isLive(i)).map((i) => (i as FolderItem).id),
    );
    const timestamp = now().toISOString();
    await transactInChunks(
      batch.map((item) => {
        const parent = item.type === 'folder' ? item.parentId : item.folderId;
        const detach = item.trashRoot === true && parent !== null && !liveFolderIds.has(parent);
        const parentAttr = item.type === 'folder' ? 'parentId' : 'folderId';
        return {
          Update: {
            TableName,
            Key: { PK: item.PK, SK: item.SK },
            UpdateExpression: `REMOVE deletedAt, trashBatchId, trashRoot, expiresAt SET updatedAt = :u${
              detach ? `, ${parentAttr} = :null` : ''
            }`,
            ConditionExpression: 'trashBatchId = :b',
            ExpressionAttributeValues: {
              ':u': timestamp,
              ':b': batchId,
              ...(detach ? { ':null': null } : {}),
            },
          },
        };
      }),
    );
    return { restored: batch.length };
  };

  /** Deletes a trash batch now instead of waiting for TTL. */
  const purgeTrash = async (userId: string, workspaceId: string, batchId: string) => {
    await requireMember(userId, workspaceId);
    const { batch } = await loadBatch(workspaceId, batchId);
    for (const scene of batch.filter((i): i is SceneItem => i.type === 'scene')) {
      await deletePrefix(scenePrefix(workspaceId, scene.id));
    }
    for (const part of chunk(batch, 25)) {
      let requests = part.map((i) => ({ DeleteRequest: { Key: { PK: i.PK, SK: i.SK } } }));
      while (requests.length) {
        const res = await ddb.send(
          new BatchWriteCommand({ RequestItems: { [TableName]: requests } }),
        );
        requests = (res.UnprocessedItems?.[TableName] ?? []) as typeof requests;
      }
    }
    return { purged: batch.length };
  };

  /** Called by the purge Lambda when TTL removes a scene item. */
  const deleteSceneObjects = (workspaceId: string, sceneId: string) =>
    deletePrefix(scenePrefix(workspaceId, sceneId));

  // -------------------------------------------------------------------- gc

  const listObjects = async (prefix: string) => {
    const objects: { key: string; lastModified: Date }[] = [];
    let ContinuationToken: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }),
      );
      for (const o of page.Contents ?? []) {
        if (o.Key) objects.push({ key: o.Key, lastModified: o.LastModified ?? new Date(0) });
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return objects;
  };

  const deleteKeys = async (keys: string[]) => {
    for (const part of chunk(keys, 1000)) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket,
          Delete: { Objects: part.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  };

  /**
   * Deletes S3 objects nothing references any more: image files no scene uses
   * (live or in the trash) and scene objects that aren't a scene's current
   * version (left behind by interrupted saves). Only objects older than
   * `minAgeMs` are touched, so in-flight uploads and saves are safe.
   */
  const collectGarbage = async ({ minAgeMs = 24 * 3600 * 1000 } = {}) => {
    const cutoff = now().getTime() - minAgeMs;
    const workspaceIds: string[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await ddb.send(
        new ScanCommand({
          TableName,
          FilterExpression: '#type = :ws',
          ExpressionAttributeNames: { '#type': 'type' },
          ExpressionAttributeValues: { ':ws': 'workspace' },
          ProjectionExpression: 'id',
          ExclusiveStartKey,
        }),
      );
      workspaceIds.push(...(page.Items ?? []).map((i) => String(i.id)));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    let filesDeleted = 0;
    let sceneObjectsDeleted = 0;
    for (const workspaceId of workspaceIds) {
      const scenes = (await loadPartition(workspaceId)).filter(
        (i): i is SceneItem => i.type === 'scene',
      );
      const currentKeys = new Set(scenes.map((s) => s.s3Key));
      const referenced = new Set<string>();
      for (const scene of scenes) {
        const object = await s3.send(new GetObjectCommand({ Bucket, Key: scene.s3Key }));
        const raw = JSON.parse((await object.Body?.transformToString()) ?? '{}') as {
          elements?: { type?: string; fileId?: string | null; isDeleted?: boolean }[];
        };
        for (const element of raw.elements ?? []) {
          // deleted elements stay in the scene (undo across sessions), so keep their files
          if (element.type === 'image' && element.fileId) referenced.add(element.fileId);
        }
      }

      const old = (o: { lastModified: Date }) => o.lastModified.getTime() < cutoff;
      const unusedFiles = (await listObjects(`ws/${workspaceId}/files/`)).filter(
        (o) => old(o) && !referenced.has(o.key.slice(o.key.lastIndexOf('/') + 1)),
      );
      const staleScenes = (await listObjects(`ws/${workspaceId}/scenes/`)).filter(
        (o) => old(o) && !currentKeys.has(o.key),
      );
      await deleteKeys([...unusedFiles, ...staleScenes].map((o) => o.key));
      filesDeleted += unusedFiles.length;
      sceneObjectsDeleted += staleScenes.length;
    }
    return { workspaces: workspaceIds.length, filesDeleted, sceneObjectsDeleted };
  };

  // ----------------------------------------------------------------- search

  const search = async (userId: string, workspaceId: string, q: string): Promise<SearchResult> => {
    await requireMember(userId, workspaceId);
    const needle = q.toLowerCase();
    const items = await loadPartition(workspaceId);
    const matches = (i: FolderItem | SceneItem) => isLive(i) && i.nameLower.includes(needle);
    return {
      folders: items
        .filter((i): i is FolderItem => i.type === 'folder' && matches(i))
        .map((f) => toFolder(workspaceId, f))
        .sort(byName),
      scenes: items
        .filter((i): i is SceneItem => i.type === 'scene' && matches(i))
        .map((s) => toScene(workspaceId, s))
        .sort(byName),
    };
  };

  // ------------------------------------------------------------------- tags

  const upsertTag = async (
    userId: string,
    workspaceId: string,
    name: string,
    input: { color: string | null },
  ) => {
    await requireMember(userId, workspaceId);
    const item: TagItem = {
      PK: wsPk(workspaceId),
      SK: tagSk(name),
      type: 'tag',
      name,
      color: input.color,
    };
    await ddb.send(new PutCommand({ TableName, Item: item }));
    return { name, color: input.color };
  };

  /** Removes the tag definition and the tag from every scene (including trash). */
  const deleteTag = async (userId: string, workspaceId: string, name: string) => {
    await requireMember(userId, workspaceId);
    const key = name.toLowerCase();
    const items = await loadPartition(workspaceId);
    const scenes = items.filter(
      (i): i is SceneItem =>
        i.type === 'scene' && (i.tags ?? []).some((t) => t.toLowerCase() === key),
    );
    await transactInChunks([
      ...scenes.map((s) => ({
        Update: {
          TableName,
          Key: { PK: s.PK, SK: s.SK },
          UpdateExpression: 'SET tags = :tags',
          ExpressionAttributeValues: { ':tags': s.tags.filter((t) => t.toLowerCase() !== key) },
        },
      })),
      { Delete: { TableName, Key: { PK: wsPk(workspaceId), SK: tagSk(name) } } },
    ]);
    return { scenesUpdated: scenes.length };
  };

  // ------------------------------------------------------------------ files

  /**
   * Presigned PUT URLs for files not stored yet. Files are content-addressed
   * and immutable, so existing ones are skipped.
   */
  const createUploadUrls = async (
    userId: string,
    workspaceId: string,
    files: { id: string; mimeType: string; size: number }[],
  ): Promise<FileUploadResult> => {
    await requireMember(userId, workspaceId);
    const results = await Promise.all(
      files.map(async (file) => {
        const Key = fileKey(workspaceId, file.id);
        if (await objectExists(Key)) {
          return { existing: file.id };
        }
        const url = await getSignedUrl(
          s3,
          new PutObjectCommand({
            Bucket,
            Key,
            ContentType: file.mimeType,
            CacheControl: 'private, max-age=31536000, immutable',
          }),
          { expiresIn: presignExpiresIn },
        );
        return {
          upload: {
            id: file.id,
            url,
            headers: {
              'content-type': file.mimeType,
              'cache-control': 'private, max-age=31536000, immutable',
            },
          },
        };
      }),
    );
    return {
      uploads: results.flatMap((r) => ('upload' in r && r.upload ? [r.upload] : [])),
      existing: results.flatMap((r) => ('existing' in r && r.existing ? [r.existing] : [])),
    };
  };

  const createDownloadUrls = async (
    userId: string,
    workspaceId: string,
    ids: string[],
  ): Promise<FileDownloadResult> => {
    await requireMember(userId, workspaceId);
    const results = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const Key = fileKey(workspaceId, id);
        if (!(await objectExists(Key))) {
          return { missing: id };
        }
        const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), {
          expiresIn: presignExpiresIn,
        });
        return { download: { id, url } };
      }),
    );
    return {
      downloads: results.flatMap((r) => ('download' in r && r.download ? [r.download] : [])),
      missing: results.flatMap((r) => ('missing' in r && r.missing ? [r.missing] : [])),
    };
  };

  return {
    listWorkspaces,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    getTree,
    createFolder,
    updateFolder,
    trashFolder,
    createScene,
    getScene,
    saveSceneContent,
    updateScene,
    trashScene,
    listTrash,
    restoreTrash,
    purgeTrash,
    deleteSceneObjects,
    collectGarbage,
    search,
    upsertTag,
    deleteTag,
    createUploadUrls,
    createDownloadUrls,
  };
};

const dedupeTags = (tags: string[]) => {
  const seen = new Set<string>();
  return tags.filter((t) => {
    const key = t.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
