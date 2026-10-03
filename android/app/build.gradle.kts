plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI passes the run number, so every published build installs over the last one.
val build = (System.getenv("RS_BUILD") ?: "1").toInt()

android {
    namespace = "io.github.mattymattmattmatt.ripstitch"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.mattymattmattmatt.ripstitch"
        minSdk = 24
        targetSdk = 34
        versionCode = 100 + build
        versionName = "1.0.$build"
    }

    // The key is in the repo on purpose: anyone can build an APK that updates over this one.
    // It identifies the app for updates; it isn't a secret.
    signingConfigs {
        create("release") {
            storeFile = rootProject.file("ripstitch-release.jks")
            storePassword = "ripstitch-public"
            keyAlias = "ripstitch"
            keyPassword = "ripstitch-public"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug { signingConfig = signingConfigs.getByName("release") }
    }

    // One APK per processor type keeps each download small.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true   // Python, FFmpeg and QuickJS run as programs from the native library folder
            keepDebugSymbols += listOf("**/libpython.zip.so", "**/libffmpeg.zip.so")   // zips, not ELF: never strip
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/rsAssets"))
}

// The site and the engine come straight from docs/, so the app always matches the website.
val rsAssets = tasks.register<Sync>("rsAssets") {
    into(layout.buildDirectory.dir("generated/rsAssets"))
    from(rootProject.file("../docs")) {
        exclude("engine/**", "sw.js", "CNAME", ".nojekyll", "img/og.png", "img/screen-*.jpg")
        into("app/site")
    }
    from(rootProject.file("../docs/engine/ripstitch_engine.py")) { into("app/engine") }
    from(file("src/rs")) { into("app") }
}
tasks.named("preBuild") { dependsOn(rsAssets) }

dependencies {
    implementation("io.github.junkfood02.youtubedl-android:library:0.18.1")
    implementation("io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
