# @jeremy/mere-rescue-image

Build and verify a reproducible x86_64 Mere rescue image from an immutable
MereLinux commit. The `build` method assembles the image with fixed argv in an
isolated workspace, checks the safety sentinel and the source commit, and
records the image digest, a machine-readable manifest with provenance, and a
safety result. It does not clone the repository: a workflow checks out the
commit first and passes the path in.

This extension was split out of `@jeremy/mere`. The method, its arguments, and
its resources are the same; only the type name changed from
`@jeremy/mere/rescue-image` to `@jeremy/mere-rescue-image`.

## Create a model

```sh
swamp model create @jeremy/mere-rescue-image rescue-image
```

## Build

```sh
swamp model method run rescue-image build \
  --input sourcePath=/home/user/work/source \
  --input outputDir=/home/user/work/out \
  --input workspaceRoot=/home/user/work \
  --input sourceCommit=<40-character commit> \
  --input workerLabel=local \
  --input environmentProfile=mere-rescue-x86_64-v1 \
  --input mereVersion=0.23.0 \
  --input mereDevRoot=/home/user/work/mere-root \
  --input mereBinary=/home/user/work/bin/mere \
  --input toolProfileRoot=/home/user/work/tools \
  --input ovmfToolProfileRoot=/home/user/work/ovmf \
  --input safetySentinelPath=/home/user/work/source/misc-util/rescue-image.inputs.json
```

Every path must stay below `workspaceRoot`. Set `includeFixture` to also build
the test fixture and `fullCompare` to compare a second clean build byte for
byte.

## Resources

| Resource | Contents |
| --- | --- |
| `rescue-build` | Verified build output and digest summary |
| `rescue-manifest` | Machine-readable manifest with provenance |
| `rescue-safety` | Whether the disk-safety check accepted the build and left the sentinel unchanged |

## Safety

The build refuses commands that touch disks or swap (`swapon`, `fsck`,
`xfs_repair`, `btrfs`, `partprobe`, `kpartx`, and similar) and records the
result. Loop mounts are the only mounts it allows.
