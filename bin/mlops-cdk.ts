#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';

import { MLOpsRayStack } from '../lib/mlops-ray-stack';

const app = new cdk.App();

if (process.env.REGION == undefined || process.env.ACCOUNT_ID == undefined) {
  throw new Error("Environment variable REGION or ACCOUNT_ID missing");
}

const env = { 
  region: process.env.REGION,
  account: process.env.ACCOUNT_ID,
};

// get the constants
const domainName = "ml.hyper-ski.com";
const certificateArn = "arn:aws:acm:eu-west-1:135929256640:certificate/dac61c2c-3c95-4759-8787-af2ebb61a7b9";
const hostedZone = "Z0827235J20SOQKXZ8F6";

const baseStack = new MLOpsRayStack(app, 'MLOps-Ray-Stack', { 
  domainName, 
  env,
  certificateArn,
  hostedZone,
});
