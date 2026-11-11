"""Point the site's CloudFront S3 origin at an immutable release prefix.

Changes ONLY OriginPath on the single S3 origin, with an ETag-conditional update,
and prints the previous path so a rollback is one command:
    python scripts/switch_origin.py --distribution ID --origin-path /releases/<previous>
"""
import argparse
import json
import subprocess
import sys
import tempfile


def aws(*args):
    out = subprocess.run(['aws', *args, '--output', 'json'], check=True, capture_output=True, text=True)
    return json.loads(out.stdout) if out.stdout.strip() else {}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--distribution', required=True)
    parser.add_argument('--origin-path', required=True)
    args = parser.parse_args()
    if not args.origin_path.startswith('/releases/') or '..' in args.origin_path:
        sys.exit('origin path must be /releases/<id>')
    current = aws('cloudfront', 'get-distribution-config', '--id', args.distribution)
    config, etag = current['DistributionConfig'], current['ETag']
    origins = config['Origins']['Items']
    s3 = [o for o in origins if o['DomainName'].endswith('.amazonaws.com') and '.s3.' in o['DomainName']]
    if len(origins) != 1 or len(s3) != 1:
        sys.exit('expected exactly one S3 origin; refusing to guess')
    previous = s3[0].get('OriginPath', '')
    if previous == args.origin_path:
        print(json.dumps({'unchanged': True, 'origin_path': previous}))
        return
    s3[0]['OriginPath'] = args.origin_path
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as handle:
        json.dump(config, handle)
    aws('cloudfront', 'update-distribution', '--id', args.distribution, '--if-match', etag,
        '--distribution-config', 'file://' + handle.name)
    print(json.dumps({'previous_origin_path': previous, 'origin_path': args.origin_path}))


if __name__ == '__main__':
    main()
