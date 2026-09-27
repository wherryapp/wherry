buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
        // HAND EDIT 8 (native push, docs/prompts/regen-hand-edits.md): the
        // Gradle plugin that turns app/google-services.json into the
        // resources FirebaseApp reads. Applied by app/build.gradle.kts only
        // when that file exists.
        classpath("com.google.gms:google-services:4.4.4")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

