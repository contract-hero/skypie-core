// Deep-link parser — `skypie://open?path=<abs>[&from=<node id>]`,
// `skypie://reveal?path=<abs>[&from=<node id>]`, `skypie://receive?ticket=<t>`,
// `skypie://beam?path=<abs>`, `skypie://pair?ticket=<t>`.
// Pure URL parsing, no Tauri dependency.

use percent_encoding::percent_decode_str;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkIntent {
    Open {
        path: PathBuf,
        line: Option<u32>,
        /// The NodeId of the device the file lives on. Absent = this one.
        from: Option<String>,
    },
    /// C3: the `reveal` verb selects + expands in the tree without switching the preview.
    Reveal {
        path: PathBuf,
        from: Option<String>,
    },
    /// Beam v1: an incoming artifact offer. `name`/`size` are untrusted
    /// display hints; the ticket's hash is the truth. Parsing performs NO
    /// network action — the confirm dialog stands between this intent and
    /// any fetch.
    Receive {
        ticket: String,
        name: Option<String>,
        size: Option<u64>,
    },
    /// Beam v1: ask the app to offer a file (CLI `skypie beam <path>`).
    /// Opens the send dialog — a hostile link cannot mint an offer without
    /// the user clicking through it.
    Beam {
        path: PathBuf,
    },
    /// Scope v2: a pairing invitation minted by another instance. Parsing
    /// performs NO network action — the fingerprint confirmation stands
    /// between this intent and a persisted peer.
    Pair {
        ticket: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum DeepLinkError {
    #[error("not a skypie:// url: {input:?}")]
    NotSkyPieScheme { input: String },
    #[error("malformed url: {input:?} — {reason}")]
    Malformed { input: String, reason: String },
    #[error("missing required parameter {param:?} in {input:?}")]
    MissingParameter { input: String, param: String },
    #[error("unknown verb {verb:?} in {input:?}")]
    UnknownVerb { input: String, verb: String },
}

/// Decode percent-encoded query-string value into a String. UTF-8-safe.
/// Returns Err if the percent-encoding is invalid (bad sequences like %ZZ).
fn pct_decode_value_strict(s: &str) -> Result<String, String> {
    // Pre-validate: check that every `%` is followed by exactly two valid hex digits.
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' {
            if i + 2 >= chars.len() {
                return Err(format!("truncated percent-sequence at position {i}"));
            }
            let h1 = chars[i + 1];
            let h2 = chars[i + 2];
            if !h1.is_ascii_hexdigit() || !h2.is_ascii_hexdigit() {
                return Err(format!("invalid percent-sequence %{h1}{h2} at position {i}"));
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    // Use percent_encoding crate directly (T-016: handles multibyte UTF-8 correctly).
    percent_decode_str(s)
        .decode_utf8()
        .map(|cow| cow.into_owned())
        .map_err(|e| e.to_string())
}

/// Parse a query string using strict UTF-8 decoding.
fn parse_query_strict(query: &str) -> Result<Vec<(String, String)>, String> {
    let mut result = Vec::new();
    for pair in query.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = match parts.next() {
            Some(k) if !k.is_empty() => k,
            _ => continue,
        };
        let val = parts.next().unwrap_or("");
        let decoded = pct_decode_value_strict(val)?;
        result.push((key.to_string(), decoded));
    }
    Ok(result)
}

// ── Per-verb building blocks ────────────────────────────────────────────────
// Every verb arm is composed from these, so a new verb cannot silently lose
// a validation step — exactly what happened once when `reveal` was copied
// from `open` without the absolute-path/NUL checks.

/// Parse the verb's query string, treating a missing query as a missing
/// `param` (the parameter the verb cannot exist without).
fn parse_query_for(
    input: &str,
    query_opt: Option<&str>,
    param: &str,
) -> Result<Vec<(String, String)>, DeepLinkError> {
    let query = query_opt.ok_or_else(|| DeepLinkError::MissingParameter {
        input: input.to_string(),
        param: param.to_string(),
    })?;
    parse_query_strict(query).map_err(|reason| DeepLinkError::Malformed {
        input: input.to_string(),
        reason,
    })
}

/// Find a required, non-empty parameter value.
fn require_param<'a>(
    input: &str,
    params: &'a [(String, String)],
    param: &str,
) -> Result<&'a str, DeepLinkError> {
    params
        .iter()
        .find(|(k, _)| k == param)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| DeepLinkError::MissingParameter {
            input: input.to_string(),
            param: param.to_string(),
        })
}

/// Find an optional, non-empty parameter value.
fn optional_param(params: &[(String, String)], param: &str) -> Option<String> {
    params
        .iter()
        .find(|(k, _)| k == param)
        .map(|(_, v)| v.clone())
        .filter(|v| !v.is_empty())
}

/// The required `path` parameter with the shared validation every path verb
/// gets: absolute, no NUL bytes (T-017).
fn require_abs_path(
    input: &str,
    params: &[(String, String)],
) -> Result<PathBuf, DeepLinkError> {
    let path_val = require_param(input, params, "path")?;

    if !path_val.starts_with('/') {
        return Err(DeepLinkError::Malformed {
            input: input.to_string(),
            reason: "path must be absolute (start with '/')".to_string(),
        });
    }

    if path_val.contains('\0') {
        return Err(DeepLinkError::Malformed {
            input: input.to_string(),
            reason: "path must not contain NUL bytes".to_string(),
        });
    }

    Ok(PathBuf::from(path_val))
}

/// The optional `from` parameter: a NodeId, which is 32 bytes as 64 lowercase
/// hex characters. Empty is absent; anything else that is present must be
/// exactly that shape, so a mangled link fails here rather than as "not
/// paired with <garbage>".
fn optional_node_id(
    input: &str,
    params: &[(String, String)],
) -> Result<Option<String>, DeepLinkError> {
    let Some(raw) = optional_param(params, "from") else {
        return Ok(None);
    };
    let well_formed = raw.len() == 64
        && raw.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c));
    if !well_formed {
        return Err(DeepLinkError::Malformed {
            input: input.to_string(),
            reason: "from must be a node id (64 lowercase hex characters)".to_string(),
        });
    }
    Ok(Some(raw))
}

/// The required `ticket` parameter with the shared validation every ticket
/// verb gets. Tickets are base32 strings; alphanumeric-only is a strict
/// superset that rejects NUL, separators and quoting tricks before any ticket
/// parser sees the value. Shared by `receive` and `pair` so a new ticket verb
/// cannot silently lose the charset check.
fn require_ticket(input: &str, params: &[(String, String)]) -> Result<String, DeepLinkError> {
    let ticket = require_param(input, params, "ticket")?;
    if !ticket.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(DeepLinkError::Malformed {
            input: input.to_string(),
            reason: "ticket must be alphanumeric".to_string(),
        });
    }
    Ok(ticket.to_string())
}

/// Parse a `skypie://` URL string into a typed intent. The https twin that
/// circulates in chat (`skypie_ipc::WEB_LINK_PREFIX`) is accepted too, so a
/// pasted web link opens like the raw one. Only `open?…` intents travel that way.
pub fn parse(url: &str) -> Result<DeepLinkIntent, DeepLinkError> {
    let input = url.to_string();
    let raw = skypie_ipc::open_link_of_web(url).unwrap_or_else(|| input.clone());

    let rest = raw.strip_prefix("skypie://").ok_or_else(|| {
        DeepLinkError::NotSkyPieScheme {
            input: input.clone(),
        }
    })?;

    if rest.is_empty() {
        return Err(DeepLinkError::Malformed {
            input: input.clone(),
            reason: "missing verb".to_string(),
        });
    }

    let (verb_part, query_opt) = match rest.find('?') {
        Some(pos) => (&rest[..pos], Some(&rest[pos + 1..])),
        None => (rest, None),
    };

    if verb_part.is_empty() {
        return Err(DeepLinkError::Malformed {
            input: input.clone(),
            reason: "empty verb".to_string(),
        });
    }

    match verb_part {
        "open" => {
            let params = parse_query_for(&input, query_opt, "path")?;
            let path = require_abs_path(&input, &params)?;
            let line = params
                .iter()
                .find(|(k, _)| k == "line")
                .and_then(|(_, v)| v.parse::<u32>().ok());
            let from = optional_node_id(&input, &params)?;
            Ok(DeepLinkIntent::Open { path, line, from })
        }
        "reveal" => {
            let params = parse_query_for(&input, query_opt, "path")?;
            let path = require_abs_path(&input, &params)?;
            let from = optional_node_id(&input, &params)?;
            Ok(DeepLinkIntent::Reveal { path, from })
        }
        "receive" => {
            let params = parse_query_for(&input, query_opt, "ticket")?;
            let ticket = require_ticket(&input, &params)?;

            Ok(DeepLinkIntent::Receive {
                ticket,
                name: optional_param(&params, "name"),
                size: optional_param(&params, "size").and_then(|v| v.parse::<u64>().ok()),
            })
        }
        "beam" => {
            let params = parse_query_for(&input, query_opt, "path")?;
            let path = require_abs_path(&input, &params)?;
            Ok(DeepLinkIntent::Beam { path })
        }
        "pair" => {
            let params = parse_query_for(&input, query_opt, "ticket")?;
            Ok(DeepLinkIntent::Pair { ticket: require_ticket(&input, &params)? })
        }
        other => Err(DeepLinkError::UnknownVerb {
            input: input.clone(),
            verb: other.to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_https_twin_parses_like_the_raw_link_and_only_for_open() {
        let ok = "a".repeat(64);
        let web = skypie_ipc::web_link_of(&format!("skypie://open?path=/w/a.html&from={ok}")).unwrap();
        assert!(web.starts_with("https://"));
        assert_eq!(
            parse(&web).unwrap(),
            DeepLinkIntent::Open { path: PathBuf::from("/w/a.html"), line: None, from: Some(ok.clone()) }
        );
        let pair = skypie_ipc::web_link_of("skypie://pair?ticket=abc123").unwrap();
        assert!(matches!(parse(&pair), Err(DeepLinkError::NotSkyPieScheme { .. })));
        let e = parse("https://skypie.ai/l#open?path=relative.html").unwrap_err();
        assert!(e.to_string().contains("https://"), "errors echo what the user pasted: {e}");
    }

    #[test]
    fn a_from_that_is_not_a_node_id_is_refused_before_any_peer_lookup() {
        let ok = "a".repeat(64);
        assert!(matches!(
            parse(&format!("skypie://open?path=/w/a.html&from={ok}")),
            Ok(DeepLinkIntent::Open { from: Some(_), .. })
        ));
        for bad in [ok.to_uppercase(), "a".repeat(63), "a".repeat(65), "g".repeat(64)] {
            let e = parse(&format!("skypie://open?path=/w/a.html&from={bad}")).unwrap_err();
            assert!(matches!(e, DeepLinkError::Malformed { .. }), "{bad}");
        }
        // Empty is absent, which is a LOCAL open — not an error.
        assert!(matches!(
            parse("skypie://open?path=/w/a.html&from="),
            Ok(DeepLinkIntent::Open { from: None, .. })
        ));
        // The same rule on the other verb that takes `from`.
        assert!(parse("skypie://reveal?path=/w/a.html&from=zz").is_err());
        assert!(matches!(
            parse(&format!("skypie://reveal?path=/w/a.html&from={ok}")),
            Ok(DeepLinkIntent::Reveal { from: Some(_), .. })
        ));
    }
}
