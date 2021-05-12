import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as MLOpsEcsBaseStack from '../lib/mlops-ecs-base-stack';

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new MLOpsEcsBaseStack.MLOpsEcsBaseStack(app, 'MyTestStack', { domainName: "example.com" });
    // THEN
    expectCDK(stack).to(matchTemplate({
      "Resources": {}
    }, MatchStyle.EXACT))
});
