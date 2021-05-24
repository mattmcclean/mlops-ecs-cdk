#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as rds from '@aws-cdk/aws-rds';
import * as iam from '@aws-cdk/aws-iam';
import * as ssm from '@aws-cdk/aws-ssm';

export interface MLOpsRdsStackProps extends cdk.StackProps {
    vpc: ec2.IVpc;

    sourceSg: ec2.ISecurityGroup;
}

export class MLOpsRdsStack extends cdk.Stack {

    constructor(scope: cdk.Construct, id: string, props: MLOpsRdsStackProps) {
        super(scope, id, props);

        const cluster = new rds.ServerlessCluster(this, 'AnotherCluster', {
            engine: rds.DatabaseClusterEngine.AURORA_POSTGRESQL,
            parameterGroup: rds.ParameterGroup.fromParameterGroupName(this, 'ParameterGroup', 'default.aurora-postgresql10'),
            vpc: props.vpc,
            scaling: {
              autoPause: cdk.Duration.minutes(15),
              minCapacity: rds.AuroraCapacityUnit.ACU_8, // default is 2 Aurora capacity units (ACUs)
              maxCapacity: rds.AuroraCapacityUnit.ACU_32, // default is 16 Aurora capacity units (ACUs)
            }
        });

        // allow Ray cluster to talk to Database
        cluster.connections.allowFrom(props.sourceSg, ec2.Port.tcp(cluster.clusterEndpoint.port));

        // allow the Ray cluster to read the Postgres secrets value
        const roleArn = ssm.StringParameter.valueForStringParameter(this, 'ray-head-role-arn');
        const role = iam.Role.fromRoleArn(this, 'Role', roleArn);
        role.addToPolicy(new iam.PolicyStatement({
          resources: [ cluster.secret?.secretArn || '*'],
          actions: ['secretsmanager:GetSecretValue'],
        }));

        new cdk.CfnOutput(this, "PostgresEndpointOutput", {
          value: cluster.clusterEndpoint.socketAddress,
        }); 
        
        new cdk.CfnOutput(this, "PostgresSecretArn", {
          value: cluster.secret?.secretArn || '',
        });            
    }
}