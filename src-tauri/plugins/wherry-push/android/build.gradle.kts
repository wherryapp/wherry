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
    // RingEnvelopeTest runs RingEnvelope (no Android API) on the JVM.
    testImplementation("junit:junit:4.13.2")
}
