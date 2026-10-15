use std::cmp::Ordering;

use ring::digest::{digest, SHA256};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct GoldenVectors {
    schema: String,
    vectors: Vec<GoldenVector>,
}

#[derive(Deserialize)]
struct GoldenVector {
    name: String,
    value: Value,
    canonical: String,
    sha256: String,
}

#[test]
fn rust_matches_sophia_canonical_json_vectors() {
    let vectors: GoldenVectors = serde_json::from_str(include_str!(
        "../../../packages/canonical-json/golden-vectors.json"
    ))
    .expect("golden vectors must be valid JSON");
    assert_eq!(vectors.schema, "sophia.canonical-json-golden-vectors.v1");

    for vector in vectors.vectors {
        let canonical = canonical_json(&vector.value);
        assert_eq!(canonical, vector.canonical, "{} bytes", vector.name);
        assert_eq!(
            sha256_hex(canonical.as_bytes()),
            vector.sha256,
            "{} digest",
            vector.name
        );
    }
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => canonical_number(value),
        Value::String(value) => serde_json::to_string(value).expect("string must serialize"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| utf16_cmp(left, right));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("key must serialize"),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn canonical_number(value: &serde_json::Number) -> String {
    if let Some(value) = value.as_i64() {
        return value.to_string();
    }
    if let Some(value) = value.as_u64() {
        return value.to_string();
    }

    let value = value.as_f64().expect("JSON number must fit f64");
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if (1e-6..1e21).contains(&magnitude) {
        return value.to_string();
    }

    let rendered = format!("{value:e}");
    let (coefficient, exponent) = rendered
        .split_once('e')
        .expect("scientific number must contain an exponent");
    let exponent = exponent
        .parse::<i32>()
        .expect("exponent must be an integer");
    format!(
        "{coefficient}e{}{}",
        if exponent >= 0 { "+" } else { "" },
        exponent
    )
}

fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
