//! Fire-and-forget child-process spawning.

/// Spawn `cmd` and reap it on a throwaway thread. Dropping the `Child` handle
/// would NOT detach the process — an exited child would linger as a zombie
/// until waited on — so a background thread waits on it; the thread never
/// influences the child's lifetime. Callers build and configure the `Command`
/// (args, platform quirks) before handing it over.
pub(crate) fn spawn_detached(mut cmd: std::process::Command) -> Result<(), String> {
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}
