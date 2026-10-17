//! Where the app may send a request on behalf of a saved link (NP-019): only
//! HTTP(S) to public addresses. A saved page must not make the app reach the
//! user's computer or local network — a router page, a printer, a dev server.
//!
//! Addresses are checked where the connection is made: hostnames through
//! [`GuardedResolver`] (so a name that later resolves elsewhere is checked
//! again), IP literals and redirect targets through [`allowed_url`].
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use url::{Host, Url};

/// Public unicast addresses only.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(a == 0 // "this network"
        || a == 10 // private
        || a == 127 // loopback
        || (a == 100 && (64..128).contains(&b)) // shared address space (CGNAT)
        || (a == 169 && b == 254) // link-local
        || (a == 172 && (16..32).contains(&b)) // private
        || (a == 192 && b == 168) // private
        || (a == 192 && b == 0 && ip.octets()[2] == 0) // IETF protocol assignments
        || (a == 198 && (18..20).contains(&b)) // benchmarking
        || a >= 224) // multicast, reserved, broadcast
}

fn public_v6(ip: Ipv6Addr) -> bool {
    // An IPv4 address carried in IPv6 is judged as IPv4.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return public_v4(v4);
    }
    let segments = ip.segments();
    if segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        // NAT64 well-known prefix: the last 32 bits are an IPv4 address.
        let [.., hi, lo] = segments;
        return public_v4(Ipv4Addr::from(((hi as u32) << 16) | lo as u32));
    }
    !(ip.is_unspecified()
        || ip.is_loopback()
        || (segments[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
        || (segments[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (segments[0] & 0xffc0) == 0xfec0 // old site-local fec0::/10
        || (segments[0] & 0xff00) == 0xff00 // multicast
        || segments[..6] == [0, 0, 0, 0, 0, 0]) // IPv4-compatible ::a.b.c.d, deprecated
}

/// A URL the app may request: HTTP(S), not a local name, not a non-public IP.
/// Hostnames are checked again when they resolve.
pub fn allowed_url(url: &Url, allow: fn(IpAddr) -> bool) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    match url.host() {
        Some(Host::Ipv4(ip)) => allow(IpAddr::V4(ip)),
        Some(Host::Ipv6(ip)) => allow(IpAddr::V6(ip)),
        Some(Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            !(name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local"))
        }
        None => false,
    }
}

/// A name that resolves to no allowed address: the request is refused, not failed.
#[derive(Debug)]
pub struct NotPublic(pub String);

impl std::fmt::Display for NotPublic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} resolves to no public address", self.0)
    }
}

impl std::error::Error for NotPublic {}

/// Resolves a hostname and keeps only allowed addresses; none left is an error.
pub async fn resolve(host: &str, allow: fn(IpAddr) -> bool) -> std::io::Result<Vec<SocketAddr>> {
    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, 0)).await?.collect();
    let allowed: Vec<SocketAddr> = addresses.iter().copied().filter(|a| allow(a.ip())).collect();
    if allowed.is_empty() {
        return Err(std::io::Error::other(NotPublic(host.to_string())));
    }
    Ok(allowed)
}

/// A URL the WebView may load, judged without the network: for addresses
/// that come from a file, not from a page the app fetched.
pub fn public_url(raw: &str) -> bool {
    Url::parse(raw).is_ok_and(|url| allowed_url(&url, public_ip))
}

/// A URL the WebView may load as a preview or icon: allowed, and its host
/// resolves to public addresses only.
pub async fn public_resource(raw: &str) -> bool {
    public_resource_answer(raw).await.unwrap_or(false)
}

/// [`public_resource`], with no answer (`None`) for a name that could not be
/// looked up: offline or a failing resolver says nothing about the host, and
/// the WebView asks again later instead of remembering a refusal.
pub async fn public_resource_answer(raw: &str) -> Option<bool> {
    let Ok(url) = Url::parse(raw) else {
        return Some(false);
    };
    if !allowed_url(&url, public_ip) {
        return Some(false);
    }
    match url.host() {
        Some(Host::Domain(name)) => match tokio::net::lookup_host((name, 0)).await {
            // The WebView resolves the name itself: every address must be public.
            Ok(addresses) => {
                let addresses: Vec<_> = addresses.collect();
                Some(!addresses.is_empty() && addresses.iter().all(|a| public_ip(a.ip())))
            }
            Err(_) => None,
        },
        _ => Some(true),
    }
}

/// reqwest's resolver for metadata requests: connects only to allowed addresses.
pub struct GuardedResolver {
    pub allow: fn(IpAddr) -> bool,
}

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let allow = self.allow;
        Box::pin(async move {
            let addresses = resolve(name.as_str(), allow).await?;
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

pub fn resolver(allow: fn(IpAddr) -> bool) -> Arc<GuardedResolver> {
    Arc::new(GuardedResolver { allow })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn local_and_private_addresses_are_refused() {
        for blocked in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.0.1",
            "64:ff9b::a00:1",   // NAT64 of 10.0.0.1
            "::127.0.0.1",      // IPv4-compatible
        ] {
            assert!(!public_ip(ip(blocked)), "{blocked} must be refused");
        }
    }

    #[test]
    fn public_addresses_pass() {
        for allowed in ["93.184.215.14", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"] {
            assert!(public_ip(ip(allowed)), "{allowed} must pass");
        }
    }

    #[test]
    fn only_http_to_public_hosts() {
        let ok = |s: &str| allowed_url(&Url::parse(s).unwrap(), public_ip);
        assert!(ok("https://example.com/page"));
        assert!(ok("http://93.184.215.14/"));
        assert!(!ok("ftp://example.com/"));
        assert!(!ok("file:///C:/Windows/win.ini"));
        assert!(!ok("http://127.0.0.1:1420/"));
        assert!(!ok("http://[::1]/"));
        assert!(!ok("http://192.168.0.1/admin"));
        assert!(!ok("http://localhost:8080/"));
        assert!(!ok("http://app.localhost/"));
        assert!(!ok("http://printer.local/"));
        assert!(!ok("http://LOCALHOST./"));
        // Decimal and hex forms are normalised by the URL parser.
        assert!(!ok("http://2130706433/"));
        assert!(!ok("http://0x7f.1/"));
    }

    #[test]
    fn a_picture_from_a_file_needs_a_public_web_address() {
        assert!(public_url("https://www.google.com/s2/favicons?domain=example.com&sz=128"));
        assert!(public_url("http://93.184.215.14/logo.png"));
        for refused in [
            "http://192.168.1.1/cgi-bin/reboot",
            "http://localhost:1420/x.png",
            "http://[::1]/x.png",
            "data:image/png;base64,AAAA",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "not an address",
        ] {
            assert!(!public_url(refused), "{refused} must be refused");
        }
    }

    #[tokio::test]
    async fn a_name_of_a_local_address_does_not_resolve() {
        assert!(resolve("localhost", public_ip).await.is_err());
        assert!(!public_resource("http://localhost/icon.png").await);
        assert!(!public_resource("http://127.0.0.1/icon.png").await);
        assert!(!public_resource("javascript:alert(1)").await);
        // Refusals by the address itself are answers, not «could not tell».
        assert_eq!(public_resource_answer("http://127.0.0.1/icon.png").await, Some(false));
        assert_eq!(public_resource_answer("http://localhost/icon.png").await, Some(false));
        assert_eq!(public_resource_answer("http://93.184.215.14/logo.png").await, Some(true));
        // `.invalid` never resolves (RFC 6761): no answer, asked again later.
        assert_eq!(public_resource_answer("https://pictures.invalid/a.png").await, None);
    }
}
