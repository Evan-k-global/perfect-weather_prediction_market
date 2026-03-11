use anyhow::{anyhow, Result};

pub fn parse_hex32(input: &str) -> Result<[u8; 32]> {
    let normalized = input.trim().trim_start_matches("0x");
    let bytes = hex::decode(normalized)?;
    if bytes.len() != 32 {
        return Err(anyhow!("expected 32-byte hex payload, got {} bytes", bytes.len()));
    }

    let mut out = [0_u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

pub fn split_signature_64(signature: &[u8]) -> Result<([u8; 32], [u8; 32])> {
    if signature.len() != 64 {
        return Err(anyhow!(
            "expected compact 64-byte signature, got {} bytes",
            signature.len()
        ));
    }

    let mut r = [0_u8; 32];
    let mut s = [0_u8; 32];
    r.copy_from_slice(&signature[0..32]);
    s.copy_from_slice(&signature[32..64]);

    Ok((r, s))
}

pub fn required_env(name: &str) -> Result<String> {
    std::env::var(name).map_err(|_| anyhow!("missing required env var: {name}"))
}

pub fn sanitize_http_path(value: &str) -> Result<String> {
    if value.contains('\r') || value.contains('\n') {
        return Err(anyhow!("TLSN_ENDPOINT must not contain CRLF characters"));
    }
    if !value.starts_with('/') {
        return Err(anyhow!("TLSN_ENDPOINT must start with '/'"));
    }
    if value.contains(' ') || value.contains('\t') {
        return Err(anyhow!(
            "TLSN_ENDPOINT must not contain whitespace characters"
        ));
    }

    Ok(value.to_string())
}

pub fn sanitize_http_host_header_value(value: &str) -> Result<String> {
    if value.contains('\r') || value.contains('\n') {
        return Err(anyhow!(
            "TLSN_SERVER_DOMAIN must not contain CRLF characters"
        ));
    }
    if value.trim().is_empty() {
        return Err(anyhow!("TLSN_SERVER_DOMAIN must be non-empty"));
    }
    if value.contains(' ') || value.contains('\t') {
        return Err(anyhow!(
            "TLSN_SERVER_DOMAIN must not contain whitespace characters"
        ));
    }

    Ok(value.to_string())
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::{
        parse_hex32, required_env, sanitize_http_host_header_value, sanitize_http_path,
        split_signature_64,
    };

    #[test]
    fn Given_valid_32_byte_hex_When_parsed_Then_array_is_returned() {
        let payload = "11".repeat(32);
        let parsed = parse_hex32(&payload).expect("parse should succeed");
        assert_eq!(parsed.len(), 32);
        assert_eq!(parsed[0], 0x11);
    }

    #[test]
    fn Given_invalid_hex_size_When_parsed_Then_error_is_returned() {
        let payload = "aa".repeat(10);
        assert!(parse_hex32(&payload).is_err());
    }

    #[test]
    fn Given_compact_signature_When_split_Then_r_and_s_are_extracted() {
        let payload = vec![1_u8; 64];
        let (r, s) = split_signature_64(&payload).expect("split should succeed");
        assert_eq!(r.len(), 32);
        assert_eq!(s.len(), 32);
        assert_eq!(r[0], 1);
        assert_eq!(s[0], 1);
    }

    #[test]
    fn Given_missing_TLSNOTARY_SIGNING_KEY_HEX_When_loading_required_env_Then_error_uses_fail_fast_contract(
    ) {
        let var_name = "TLSNOTARY_SIGNING_KEY_HEX";
        let previous = std::env::var(var_name).ok();
        std::env::remove_var(var_name);

        let error = required_env(var_name).expect_err("missing env var should fail");
        assert_eq!(
            error.to_string(),
            "missing required env var: TLSNOTARY_SIGNING_KEY_HEX"
        );

        if let Some(value) = previous {
            std::env::set_var(var_name, value);
        }
    }

    #[test]
    fn Given_CRLF_in_endpoint_When_sanitized_Then_error_is_returned() {
        let result = sanitize_http_path("/api/v1/employee/EMP-001\r\nX-Injected: 1");
        assert!(result.is_err());
    }

    #[test]
    fn Given_CRLF_in_server_domain_When_sanitized_Then_error_is_returned() {
        let result = sanitize_http_host_header_value("localhost\r\nX-Injected: 1");
        assert!(result.is_err());
    }
}
