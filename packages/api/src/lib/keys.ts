/** DynamoDB key and S3 object key builders (single-table design). */

export const userPk = (userId: string) => `USER#${userId}`;
export const wsPk = (workspaceId: string) => `WS#${workspaceId}`;
export const membershipSk = (workspaceId: string) => `WS#${workspaceId}`;
export const META_SK = 'META';
export const folderSk = (id: string) => `FOLDER#${id}`;
export const sceneSk = (id: string) => `SCENE#${id}`;
export const tagSk = (name: string) => `TAG#${name.toLowerCase()}`;

export const scenePrefix = (workspaceId: string, sceneId: string) =>
  `ws/${workspaceId}/scenes/${sceneId}/`;
export const sceneObjectKey = (workspaceId: string, sceneId: string, version: number) =>
  `${scenePrefix(workspaceId, sceneId)}v${version}.json`;
export const fileKey = (workspaceId: string, fileId: string) => `ws/${workspaceId}/files/${fileId}`;
