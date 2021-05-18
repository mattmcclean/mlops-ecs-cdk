import os
import json

import boto3

# create the boto3 clients
ec2 = boto3.client('ec2')
elbv2 = boto3.client('elbv2')

# Get the ALB Target Group ARNs
MLFLOW_TARGET_GROUP_ARN=os.getenv('MLFLOW_TARGET_GROUP_ARN')
TENSORBOARD_TARGET_GROUP_ARN=os.getenv('TENSORBOARD_TARGET_GROUP_ARN')
RAY_DASHBOARD_TARGET_GROUP_ARN=os.getenv('RAY_DASHBOARD_TARGET_GROUP_ARN')
JUPYTER_TARGET_GROUP_ARN=os.getenv('JUPYTER_TARGET_GROUP_ARN')
PROMETHEUS_TARGET_GROUP_ARN=os.getenv('PROMETHEUS_TARGET_GROUP_ARN')
GRAFANA_TARGET_GROUP_ARN=os.getenv('GRAFANA_TARGET_GROUP_ARN')
print(f'MLFLOW_TARGET_GROUP_ARN={MLFLOW_TARGET_GROUP_ARN}')
print(f'TENSORBOARD_TARGET_GROUP_ARN={TENSORBOARD_TARGET_GROUP_ARN}')
print(f'RAY_DASHBOARD_TARGET_GROUP_ARN={RAY_DASHBOARD_TARGET_GROUP_ARN}')
print(f'JUPYTER_TARGET_GROUP_ARN={JUPYTER_TARGET_GROUP_ARN}')
print(f'PROMETHEUS_TARGET_GROUP_ARN={PROMETHEUS_TARGET_GROUP_ARN}')
print(f'GRAFANA_TARGET_GROUP_ARN={GRAFANA_TARGET_GROUP_ARN}')

# the target group ARN to port mappping
target_group_port_mappings = [
    {
        "target_group": MLFLOW_TARGET_GROUP_ARN,
        "port": 5000
    },
    {
        "target_group": TENSORBOARD_TARGET_GROUP_ARN,
        "port": 6006
    },
    {
        "target_group": RAY_DASHBOARD_TARGET_GROUP_ARN,
        "port": 8265
    },
    {
        "target_group": JUPYTER_TARGET_GROUP_ARN,
        "port": 8888
    },
     {
        "target_group": PROMETHEUS_TARGET_GROUP_ARN,
        "port": 9090
    },
    {
        "target_group": GRAFANA_TARGET_GROUP_ARN,
        "port": 3000
    }        
]

def deregister_targets(instance_id):
    for target_port_map in target_group_port_mappings:
        deregister_target(target_port_map['target_group'], instance_id, target_port_map['port'])

def register_targets(instance_id):
    for target_port_map in target_group_port_mappings:
        register_target(target_port_map['target_group'], instance_id, target_port_map['port'])

def deregister_target(target_group, instance_id, port):
    print(f"Deregistering instance id={instance_id} and port={port} with target group={target_group}")
    response = elbv2.deregister_targets(TargetGroupArn=target_group, Targets=[ {"Id": instance_id, "Port": port }])
    print(json.dumps(response))

def register_target(target_group, instance_id, port):
    print(f"Registering instance id={instance_id} and port={port}  with target group={target_group}")
    response = elbv2.register_targets(TargetGroupArn=target_group, Targets=[ {"Id": instance_id, "Port": port }])
    print(json.dumps(response))

def is_ray_head_node(tags):
    for tag in tags:
        if tag["Key"] == 'Name' and tag["Value"].startswith("ray-") and tag["Value"].endswith("-head"):
            print(f'Tag value is {tag["Value"]}')
            return True
    return False

def lambda_handler(event, context):
    print(json.dumps(event))

    instance_id = event["detail"]["instance-id"]
    print(f'Instance ID: {instance_id}')

    # get the instance state from the message
    if event["detail"]["state"] in [  'running', 'terminated', 'stopped' ]:
        print("Getting instance details")
        response = ec2.describe_instances(InstanceIds=[instance_id])
        print(response)
        if response and len(response['Reservations']) > 0:
            instance_details = response['Reservations'][0]['Instances'][0]
            print("Instance details:")
            print(instance_details)

            instance_tags = instance_details['Tags']
            if is_ray_head_node(instance_tags):
                print("Processing head node")
                if event["detail"]["state"] == 'running':
                    register_targets(instance_id)
                else:
                    deregister_targets(instance_id)
            else:
                print("Instance is not Ray head not so ignoring")
        else:
            print(f"Instance id: {instance_id} not found")
    else:
        print(f'Ignoring event {event["detail"]["state"]}')
