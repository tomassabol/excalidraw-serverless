import { App } from 'aws-cdk-lib';

// Stacks (DataStack, AppStack) are added in Phase 2.
const app = new App();
app.synth();
