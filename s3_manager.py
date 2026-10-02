#!/usr/bin/env python3
"""
s3_manager.py - Manage AWS S3 buckets from the command line.

Operations:
  create  - create a new bucket
  list    - list all buckets in the account
  detail  - show details for a single bucket
  update  - update bucket settings (versioning, tags, public access block)
  upload  - upload a local file into a bucket
  empty   - delete every object (and version) in a bucket, keep the bucket
  delete  - delete a bucket (optionally emptying it first)

Credentials are resolved by boto3 in the usual order:
  environment variables, ~/.aws/credentials, ~/.aws/config, IAM role.
"""

import argparse
import json
import os
import sys

import boto3
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def get_client(region=None):
    """Return an S3 client, optionally pinned to a region."""
    return boto3.client("s3", region_name=region) if region else boto3.client("s3")


def parse_tags(tag_list):
    """Convert ['Key=Value', ...] into the S3 TagSet format."""
    tags = []
    for item in tag_list or []:
        if "=" not in item:
            raise ValueError(f"Invalid tag '{item}', expected Key=Value")
        key, value = item.split("=", 1)
        tags.append({"Key": key, "Value": value})
    return tags


def print_json(data):
    print(json.dumps(data, indent=2, default=str))


def error_code(exc):
    return exc.response.get("Error", {}).get("Code", "")


# --------------------------------------------------------------------------- #
# Operations
# --------------------------------------------------------------------------- #

def create_bucket(args):
    s3 = get_client(args.region)
    region = args.region or s3.meta.region_name

    params = {"Bucket": args.name}
    # us-east-1 does not accept a LocationConstraint.
    if region and region != "us-east-1":
        params["CreateBucketConfiguration"] = {"LocationConstraint": region}

    s3.create_bucket(**params)
    print(f"Bucket '{args.name}' created in {region}.")

    if args.versioning:
        s3.put_bucket_versioning(
            Bucket=args.name, VersioningConfiguration={"Status": "Enabled"}
        )
        print("Versioning enabled.")

    tags = parse_tags(args.tag)
    if tags:
        s3.put_bucket_tagging(Bucket=args.name, Tagging={"TagSet": tags})
        print(f"Applied {len(tags)} tag(s).")

    if not args.allow_public:
        s3.put_public_access_block(
            Bucket=args.name,
            PublicAccessBlockConfiguration={
                "BlockPublicAcls": True,
                "IgnorePublicAcls": True,
                "BlockPublicPolicy": True,
                "RestrictPublicBuckets": True,
            },
        )
        print("Public access blocked.")


def list_buckets(args):
    s3 = get_client(args.region)
    resp = s3.list_buckets()
    buckets = resp.get("Buckets", [])

    if args.json:
        print_json(buckets)
        return

    if not buckets:
        print("No buckets found.")
        return

    print(f"{'Name':<50} {'Created':<25}")
    print("-" * 76)
    for b in buckets:
        print(f"{b['Name']:<50} {b['CreationDate']}")
    print(f"\n{len(buckets)} bucket(s).")


def bucket_detail(args):
    s3 = get_client(args.region)
    name = args.name
    info = {"Name": name}

    loc = s3.get_bucket_location(Bucket=name).get("LocationConstraint")
    info["Region"] = loc or "us-east-1"

    try:
        ver = s3.get_bucket_versioning(Bucket=name)
        info["Versioning"] = ver.get("Status", "Disabled")
    except ClientError as exc:
        info["Versioning"] = f"error: {error_code(exc)}"

    try:
        tags = s3.get_bucket_tagging(Bucket=name)["TagSet"]
        info["Tags"] = {t["Key"]: t["Value"] for t in tags}
    except ClientError as exc:
        info["Tags"] = {} if error_code(exc) == "NoSuchTagSet" else f"error: {error_code(exc)}"

    try:
        pab = s3.get_public_access_block(Bucket=name)
        info["PublicAccessBlock"] = pab["PublicAccessBlockConfiguration"]
    except ClientError as exc:
        info["PublicAccessBlock"] = (
            "not configured"
            if error_code(exc) == "NoSuchPublicAccessBlockConfiguration"
            else f"error: {error_code(exc)}"
        )

    try:
        enc = s3.get_bucket_encryption(Bucket=name)
        rules = enc["ServerSideEncryptionConfiguration"]["Rules"]
        info["Encryption"] = [
            r["ApplyServerSideEncryptionByDefault"]["SSEAlgorithm"] for r in rules
        ]
    except ClientError as exc:
        info["Encryption"] = (
            "not configured"
            if error_code(exc) == "ServerSideEncryptionConfigurationNotFoundError"
            else f"error: {error_code(exc)}"
        )

    # Object count / size summary (first page only, to stay fast on big buckets)
    try:
        objs = s3.list_objects_v2(Bucket=name, MaxKeys=1000)
        contents = objs.get("Contents", [])
        info["ObjectCountSampled"] = len(contents)
        info["SampledSizeBytes"] = sum(o["Size"] for o in contents)
        info["MoreObjects"] = objs.get("IsTruncated", False)
    except ClientError as exc:
        info["Objects"] = f"error: {error_code(exc)}"

    if args.json:
        print_json(info)
    else:
        for key, value in info.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, default=str)
            print(f"{key:<22}: {value}")


def update_bucket(args):
    s3 = get_client(args.region)
    name = args.name
    changed = False

    if args.versioning:
        status = "Enabled" if args.versioning == "enable" else "Suspended"
        s3.put_bucket_versioning(
            Bucket=name, VersioningConfiguration={"Status": status}
        )
        print(f"Versioning set to {status}.")
        changed = True

    if args.tag:
        tags = parse_tags(args.tag)
        s3.put_bucket_tagging(Bucket=name, Tagging={"TagSet": tags})
        print(f"Tags replaced with {len(tags)} tag(s).")
        changed = True

    if args.clear_tags:
        s3.delete_bucket_tagging(Bucket=name)
        print("All tags removed.")
        changed = True

    if args.public_access:
        block = args.public_access == "block"
        s3.put_public_access_block(
            Bucket=name,
            PublicAccessBlockConfiguration={
                "BlockPublicAcls": block,
                "IgnorePublicAcls": block,
                "BlockPublicPolicy": block,
                "RestrictPublicBuckets": block,
            },
        )
        print(f"Public access {'blocked' if block else 'allowed'}.")
        changed = True

    if args.encryption:
        algo = "aws:kms" if args.encryption == "kms" else "AES256"
        rule = {"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": algo}}
        if args.kms_key_id:
            rule["ApplyServerSideEncryptionByDefault"]["KMSMasterKeyID"] = args.kms_key_id
        s3.put_bucket_encryption(
            Bucket=name,
            ServerSideEncryptionConfiguration={"Rules": [rule]},
        )
        print(f"Default encryption set to {algo}.")
        changed = True

    if not changed:
        print("Nothing to update. Use --help to see available options.")


def upload_file(args):
    s3 = get_client(args.region)
    key = args.key or os.path.basename(args.file)
    s3.upload_file(args.file, args.name, key)
    print(f"Uploaded '{args.file}' to s3://{args.name}/{key}")


def empty_bucket(s3, name, prefix=None):
    """Delete every object and version in a bucket (optionally under a prefix)."""
    deleted = 0
    paginator = s3.get_paginator("list_object_versions")
    params = {"Bucket": name}
    if prefix:
        params["Prefix"] = prefix
    for page in paginator.paginate(**params):
        items = page.get("Versions", []) + page.get("DeleteMarkers", [])
        if not items:
            continue
        objects = [{"Key": i["Key"], "VersionId": i["VersionId"]} for i in items]
        for i in range(0, len(objects), 1000):
            s3.delete_objects(
                Bucket=name, Delete={"Objects": objects[i : i + 1000], "Quiet": True}
            )
        deleted += len(objects)
    return deleted


def empty_command(args):
    s3 = get_client(args.region)
    name = args.name
    scope = f"objects under '{args.prefix}' in" if args.prefix else "ALL objects in"

    if not args.yes:
        answer = input(f"Permanently delete {scope} bucket '{name}'? [y/N]: ")
        if answer.strip().lower() not in ("y", "yes"):
            print("Aborted.")
            return

    count = empty_bucket(s3, name, args.prefix)
    print(f"Removed {count} object(s)/version(s) from '{name}'. Bucket kept.")


def delete_bucket(args):
    s3 = get_client(args.region)
    name = args.name

    if not args.yes:
        answer = input(f"Delete bucket '{name}'? This cannot be undone. [y/N]: ")
        if answer.strip().lower() not in ("y", "yes"):
            print("Aborted.")
            return

    if args.force:
        count = empty_bucket(s3, name)
        print(f"Removed {count} object(s)/version(s).")

    s3.delete_bucket(Bucket=name)
    print(f"Bucket '{name}' deleted.")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def build_parser():
    parser = argparse.ArgumentParser(
        description="Create, list, inspect, update and delete AWS S3 buckets."
    )
    parser.add_argument("--region", help="AWS region (defaults to your profile/config)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("create", help="Create a new bucket")
    p.add_argument("name", help="Bucket name (globally unique)")
    p.add_argument("--versioning", action="store_true", help="Enable versioning")
    p.add_argument("--tag", action="append", metavar="KEY=VALUE", help="Tag (repeatable)")
    p.add_argument("--allow-public", action="store_true",
                   help="Do not apply the public access block")
    p.set_defaults(func=create_bucket)

    p = sub.add_parser("list", help="List all buckets")
    p.add_argument("--json", action="store_true", help="Output as JSON")
    p.set_defaults(func=list_buckets)

    p = sub.add_parser("detail", help="Show details for a bucket")
    p.add_argument("name")
    p.add_argument("--json", action="store_true", help="Output as JSON")
    p.set_defaults(func=bucket_detail)

    p = sub.add_parser("update", help="Update bucket settings")
    p.add_argument("name")
    p.add_argument("--versioning", choices=["enable", "suspend"])
    p.add_argument("--tag", action="append", metavar="KEY=VALUE",
                   help="Replace all tags with these (repeatable)")
    p.add_argument("--clear-tags", action="store_true", help="Remove all tags")
    p.add_argument("--public-access", choices=["block", "allow"])
    p.add_argument("--encryption", choices=["aes256", "kms"],
                   help="Set default server-side encryption")
    p.add_argument("--kms-key-id", help="KMS key ID/ARN (with --encryption kms)")
    p.set_defaults(func=update_bucket)

    p = sub.add_parser("upload", help="Upload a local file into a bucket")
    p.add_argument("name", help="Bucket name")
    p.add_argument("file", help="Local file path")
    p.add_argument("--key", help="Object key in the bucket (default: file name)")
    p.set_defaults(func=upload_file)

    p = sub.add_parser("empty", help="Delete all objects in a bucket but keep the bucket")
    p.add_argument("name")
    p.add_argument("--prefix", help="Only delete objects whose key starts with this prefix")
    p.add_argument("-y", "--yes", action="store_true", help="Skip confirmation prompt")
    p.set_defaults(func=empty_command)

    p = sub.add_parser("delete", help="Delete a bucket")
    p.add_argument("name")
    p.add_argument("--force", action="store_true",
                   help="Empty the bucket (all objects and versions) before deleting")
    p.add_argument("-y", "--yes", action="store_true", help="Skip confirmation prompt")
    p.set_defaults(func=delete_bucket)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except NoCredentialsError:
        print("Error: no AWS credentials found. Run 'aws configure' or set "
              "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.", file=sys.stderr)
        sys.exit(1)
    except ClientError as exc:
        code = error_code(exc)
        msg = exc.response.get("Error", {}).get("Message", str(exc))
        print(f"AWS error ({code}): {msg}", file=sys.stderr)
        sys.exit(1)
    except (BotoCoreError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
