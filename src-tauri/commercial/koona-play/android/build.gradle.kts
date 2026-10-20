import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.koona.pin.play"
    compileSdk = 37

    defaultConfig {
        minSdk = 29
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

dependencies {
    // Google Play Billing (NP-154): the plain library with callbacks, not -ktx (no coroutines). It
    // brings the com.android.vending.BILLING permission; only the Play build carries this module.
    implementation("com.android.billingclient:billing:9.1.0")
    // Only to compile against Tauri's Plugin.onResume(AppCompatActivity): the app itself carries
    // AppCompat already (gen/android/app), so nothing new reaches the APK.
    compileOnly("androidx.appcompat:appcompat:1.7.1")
    implementation(project(":tauri-android"))
    testImplementation("junit:junit:4.13.2")
}
