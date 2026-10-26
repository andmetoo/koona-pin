import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Google Play's upload key (NP-074a), passed in by scripts/build-android.mjs from .env: the keystore's path
// and its password, the key's alias. The site's own key the same way (ANDROID_SITE_*, build:android
// --site, release.yml): its APK is not Play's, so a phone moves between the two by reinstalling. The script
// passes one of the two, never both. Without either the release build is signed with the debug key, for
// testing.
val uploadKeystore = System.getenv("ANDROID_UPLOAD_KEYSTORE")?.takeIf { it.isNotEmpty() }
val siteKeystore = System.getenv("ANDROID_SITE_KEYSTORE")?.takeIf { it.isNotEmpty() }

android {
    compileSdk = 37
    namespace = "app.koona.pin"
    signingConfigs {
        if (uploadKeystore != null) {
            create("upload") {
                storeFile = file(uploadKeystore)
                storeType = "pkcs12"
                storePassword = System.getenv("ANDROID_UPLOAD_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_UPLOAD_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_UPLOAD_KEYSTORE_PASSWORD")
            }
        }
        if (siteKeystore != null) {
            create("site") {
                storeFile = file(siteKeystore)
                storeType = "pkcs12"
                storePassword = System.getenv("ANDROID_SITE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_SITE_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_SITE_KEYSTORE_PASSWORD")
            }
        }
    }
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.koona.pin"
        // Android 10 and newer; Google Play's target for 2026 (NP-151). compileSdk follows the SDK here.
        minSdk = 29
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.findByName("upload") ?: signingConfigs.findByName("site")
                ?: signingConfigs.getByName("debug")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
