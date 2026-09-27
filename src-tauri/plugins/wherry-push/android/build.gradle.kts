// The Android half of wherry-push. In P2 this is a STUB so the skeleton
// builds for Android: no Firebase dependency yet, and PushPlugin reports an
// unconfigured build. P3 (docs/prompts/native-push-plan.md §6) owns
// android/** and replaces it.
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
    implementation(project(":tauri-android"))
}
