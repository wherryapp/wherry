// The Android half of wherry-calls, a Gradle library module that Tauri's
// build wires into gen/android (tauri.settings.gradle, generated), so no
// file under gen/ is edited for it. Versions follow gen/android's own
// (compileSdk 36, minSdk 24, Kotlin 1.9) and Tauri's first-party plugins.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.wherry.calls"
    compileSdk = 36

    // No keep rules of our own: tauri-android's consumer rules already keep
    // every @TauriPlugin class and its @Command methods through R8.
    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    // Tauri's plugin API (Plugin, Invoke, JSObject, the annotations).
    implementation(project(":tauri-android"))
    // NotificationCompat.CallStyle (A1's ongoing call, A2's ring) and
    // Person. CallStyle is not in androidx.core 1.9.0 (its classes.jar has
    // no NotificationCompat$CallStyle), the version this stub first named.
    // 1.13.1 is what the app already resolves (appcompat 1.7.1 and its
    // neighbours), so this adds nothing to the APK; plain `core`, since no
    // Kotlin extension is used.
    implementation("androidx.core:core:1.13.1")
    // RingTest runs Ring (no Android API) on the JVM, as the push plugin's
    // tests do.
    testImplementation("junit:junit:4.13.2")
}
