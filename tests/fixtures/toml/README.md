# TOML 1.0 regression corpus

Vendored byte-for-byte from [toml-lang/toml-test](https://github.com/toml-lang/toml-test)
at commit `ff49d109861c1ad25af53f687f2aef19ab650600`, restricted to
`tests/files-toml-1.0.0`. The MIT notice is in [LICENSE](LICENSE).

The subset includes all 48 cases that failed before issue #31 was fixed. Valid `.json` files use the upstream tagged-value
format. Invalid encoding fixtures must be read as bytes, not decoded with
replacement characters. CI runs this subset without network access.

Full-suite measurement at that commit:

- Before: valid **197/208**, invalid **464/501**.
- After: valid **208/208**, invalid **501/501**; no remaining failures.

Date/time results remain exact source lexemes and are normalized only by the
test comparator. Integers in the safe JavaScript range remain Numbers; larger
integers are BigInts so int64 values are never silently rounded.
