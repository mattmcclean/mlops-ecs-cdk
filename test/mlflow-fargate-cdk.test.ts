import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as MLOpsRayStack from '../lib/mlops-ray-stack';

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new MLOpsRayStack.MLOpsRayStack(app, 'MyTestStack', { 
      domainName: "example.com",
      certificateArn: "",
      hostedZone: "",
    });
    // THEN
    expectCDK(stack).to(matchTemplate({
      "Resources": {}
    }, MatchStyle.EXACT))
});
