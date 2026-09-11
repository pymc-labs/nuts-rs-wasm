# Test densities

Standard normal and Normal(3, 1), without their irrelevant normalizing constants.
The tape sources are ours. Generated with tapewasm-codegen commit
35b767bd1852fa71b74ad013d1818279af0e894b:

```
cargo run --release -p tapewasm-codegen --example tape_from_text -- normal.tape normal.wasm
```

The printed scratch_len/layout_id supply the JSON metadata. These tiny artifacts
exercise the real published sampler in tests; no compiler is needed in CI.
