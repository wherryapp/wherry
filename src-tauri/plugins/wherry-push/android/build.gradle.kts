// The Android half of wherry-push (docs/prompts/native-push-plan.md §6), a
// Gradle library module that Tauri's build wires into gen/android
// (tauri.settings.gradle, generated). The google-services Gradle plugin is
// not applied here: it reads google-services.json into the APP module's
// resources, so it is applied there (hand edit 8). Versions follow
// gen/android's own (compileSdk 36, minSdk 24, Kotlin 1.9) and Tauri's
// first-party plugins.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.wherry.push"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }

    // LabelStoreTest's failure paths reach android.util.Log.w, which --
    // like every unstubbed Android platform method -- throws "not mocked"
    // under testDebugUnitTest by default. Returning quietly instead (still
    // no Robolectric) is enough: the tests assert on LabelStore's cache and
    // the fake disk, never on what got logged.
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // Tauri's plugin API (Plugin, Invoke, JSObject, the annotations).
    implementation(project(":tauri-android"))
    // Google's only supported client for FCM tokens and delivery (§6.1).
    // The BoM pins firebase-messaging and the Firebase modules it pulls in
    // to one tested set. Nothing else from Firebase is used (no Analytics).
    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
    implementation("com.google.firebase:firebase-messaging")
    // NotificationCompat and the channels. Already in the app through
    // AppCompat; declared because this module compiles against it alone.
    implementation("androidx.core:core-ktx:1.9.0")
    // ComponentActivity.addOnNewIntentListener (PushLifecycle), the version
    // the app already uses (gen/android/app/build.gradle.kts).
    implementation("androidx.activity:activity:1.10.1")
    // RingEnvelopeTest runs RingEnvelope (no Android API) on the JVM.
    testImplementation("junit:junit:4.13.2")
    // LabelStoreTest exercises LabelStore's real org.json calls (JSONObject
    // is part of Android's platform, and its stub throws "not mocked" under
    // testDebugUnitTest for every method, toString() included); the real
    // library, on the test classpath only, makes that code actually run.
    testImplementation("org.json:json:20231013")
}
