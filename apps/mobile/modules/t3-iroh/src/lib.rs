#![forbid(unsafe_code)]

use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex, OnceLock},
};
use t3_code_ls_transport::{
    EndpointAddr, EndpointId, Forwarder, Limits, Network, RelayUrl, SecretKey,
};
use tokio::runtime::{Builder, Runtime};

uniffi::setup_scaffolding!();

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum TunnelError {
    #[error("Invalid Iroh device identity")]
    InvalidIdentity,
    #[error("Invalid Iroh route")]
    InvalidRoute,
    #[error("Iroh runtime is unavailable")]
    Runtime,
    #[error("Iroh tunnel could not be started or stopped")]
    Transport,
}

fn device_key(bytes: &[u8]) -> Result<SecretKey, TunnelError> {
    Ok(SecretKey::from_bytes(
        bytes.try_into().map_err(|_| TunnelError::InvalidIdentity)?,
    ))
}

#[uniffi::export]
pub fn device_endpoint_id(secret_key: Vec<u8>) -> Result<String, TunnelError> {
    Ok(device_key(&secret_key)?.public().to_string())
}

fn runtime() -> Result<&'static Runtime, TunnelError> {
    static RUNTIME: OnceLock<Result<Runtime, std::io::Error>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
        })
        .as_ref()
        .map_err(|_| TunnelError::Runtime)
}

#[derive(uniffi::Object)]
pub struct IrohTunnel {
    forwarder: Mutex<Option<Forwarder>>,
}

#[uniffi::export]
impl IrohTunnel {
    #[uniffi::constructor]
    pub fn open(
        secret_key: Vec<u8>,
        remote: String,
        addresses: Vec<String>,
        relay: Option<String>,
    ) -> Result<Arc<Self>, TunnelError> {
        let secret = device_key(&secret_key)?;
        let peer = remote
            .parse::<EndpointId>()
            .map_err(|_| TunnelError::InvalidRoute)?;
        if addresses.len() > 16 || (addresses.is_empty() && relay.is_none()) {
            return Err(TunnelError::InvalidRoute);
        }
        let mut remote = EndpointAddr::new(peer);
        for address in addresses {
            remote = remote.with_ip_addr(
                address
                    .parse::<SocketAddr>()
                    .map_err(|_| TunnelError::InvalidRoute)?,
            );
        }
        let network = match relay {
            Some(relay) => {
                let relay: RelayUrl = relay.parse().map_err(|_| TunnelError::InvalidRoute)?;
                remote = remote.with_relay_url(relay.clone());
                Network::Relays(vec![relay])
            }
            None => Network::Direct,
        };
        let forwarder = runtime()?
            .block_on(Forwarder::bind(
                secret,
                network,
                remote,
                SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                Limits::default(),
            ))
            .map_err(|_| TunnelError::Transport)?;
        Ok(Arc::new(Self {
            forwarder: Mutex::new(Some(forwarder)),
        }))
    }

    pub fn port(&self) -> Result<Option<u16>, TunnelError> {
        let forwarder = self.forwarder.lock().map_err(|_| TunnelError::Runtime)?;
        Ok(forwarder
            .as_ref()
            .map(|forwarder| forwarder.local_addr().port()))
    }

    pub fn close(&self) -> Result<(), TunnelError> {
        let forwarder = self
            .forwarder
            .lock()
            .map_err(|_| TunnelError::Runtime)?
            .take();
        if let Some(forwarder) = forwarder {
            runtime()?
                .block_on(forwarder.shutdown())
                .map_err(|_| TunnelError::Transport)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_id_matches_the_tunnel_key() {
        let key = vec![0x43; 32];
        let expected = device_key(&key).unwrap().public().to_string();
        assert_eq!(device_endpoint_id(key).unwrap(), expected);
        assert!(matches!(
            device_endpoint_id(vec![0; 31]),
            Err(TunnelError::InvalidIdentity)
        ));
    }

    #[test]
    fn route_without_contact_addresses_is_rejected() {
        let key = vec![0x43; 32];
        let peer = device_endpoint_id(vec![0x41; 32]).unwrap();
        assert!(matches!(
            IrohTunnel::open(key, peer, Vec::new(), None),
            Err(TunnelError::InvalidRoute)
        ));
    }
}
