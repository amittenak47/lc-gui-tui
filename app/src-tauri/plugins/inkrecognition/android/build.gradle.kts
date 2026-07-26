plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.lc.whiteboard.inkrecognition"
    compileSdk = 34

    defaultConfig {
        // The Magic Note Pad runs Android 14; 24 keeps older tablets usable.
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    // Tauri's Android runtime, supplied by the generated project.
    implementation(project(":tauri-android"))

    // ML Kit Digital Ink Recognition: on-device, offline once the model is
    // downloaded, and free. The model itself is fetched at runtime by
    // RemoteModelManager, not bundled, which keeps the APK small.
    implementation("com.google.mlkit:digital-ink-recognition:18.1.0")
}
