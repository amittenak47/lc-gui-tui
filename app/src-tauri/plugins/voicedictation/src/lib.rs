//! Speech-to-text into the agent composer through Android's SpeechRecognizer.
//!
//! The page never calls these commands itself. The host `voice_*` commands do,
//! and the recognizer pushes partial and final text back as `lc-voice` events.

use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{Manager, Runtime};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "dev.lc.whiteboard.voicedictation";

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[error("voice dictation is only available on Android")]
    Unsupported,
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Deserialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct PathResponse {
    path: String,
}

pub struct VoiceDictation<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> VoiceDictation<R> {
    pub fn available(&self) -> Result<bool> {
        let response = self.0.run_mobile_plugin::<OkResponse>("is_available", ())?;
        Ok(response.ok)
    }

    pub fn start(&self) -> Result<()> {
        self.0.run_mobile_plugin::<OkResponse>("start", ())?;
        Ok(())
    }

    pub fn stop(&self) -> Result<()> {
        self.0.run_mobile_plugin::<OkResponse>("stop", ())?;
        Ok(())
    }

    pub fn record_start(&self) -> Result<()> {
        self.0.run_mobile_plugin::<OkResponse>("record_start", ())?;
        Ok(())
    }

    /// Absolute path of the finished WAV. The plugin does not emit the closing events.
    pub fn record_stop(&self) -> Result<String> {
        let response = self.0.run_mobile_plugin::<PathResponse>("record_stop", ())?;
        Ok(response.path)
    }

    pub fn record_cancel(&self) -> Result<()> {
        self.0.run_mobile_plugin::<OkResponse>("record_cancel", ())?;
        Ok(())
    }

    pub fn cancel(&self) -> Result<()> {
        self.0.run_mobile_plugin::<OkResponse>("cancel", ())?;
        Ok(())
    }
}

pub trait VoiceDictationExt<R: Runtime> {
    fn voice_dictation(&self) -> Option<&VoiceDictation<R>>;
}

impl<R: Runtime, T: Manager<R>> VoiceDictationExt<R> for T {
    fn voice_dictation(&self) -> Option<&VoiceDictation<R>> {
        self.try_state::<VoiceDictation<R>>().map(|state| state.inner())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("voicedictation")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "VoiceDictationPlugin")?;
                app.manage(VoiceDictation::<R>(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                let _ = app;
            }
            Ok(())
        })
        .build()
}
