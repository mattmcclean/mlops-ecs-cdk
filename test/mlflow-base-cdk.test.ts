import { expect as expectCDK, matchTemplate, MatchStyle } from '@aws-cdk/assert';
import * as cdk from '@aws-cdk/core';
import * as MLOpsBaseStack from '../lib/mlops-base-stack';

test('Empty Stack', () => {
    const app = new cdk.App();
    // WHEN
    const stack = new MLOpsBaseStack.MLOpsBaseStack(app, 'MyTestStack');
    // THEN
    expectCDK(stack).to(matchTemplate({
      "Resources": {}
    }, MatchStyle.EXACT))
});
