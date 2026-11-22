plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// L'interface web (dossier racine du dépôt) est copiée dans les assets de l'APK à chaque build.
val webRoot = rootProject.projectDir.parentFile
val webAssets = layout.buildDirectory.dir("generated/webassets")
val copyWeb by tasks.registering(Sync::class) {
    from(webRoot) { include("index.html", "manifest.json", "css/**", "js/**", "icons/**") }
    into(webAssets.map { it.dir("www") })
}

android {
    namespace = "app.wheeltop.profils"
    compileSdk = 34

    defaultConfig {
        applicationId = "app.wheeltop.profils"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        // Clé fixe (non secrète, mot de passe "android") pour que les mises à jour s'installent
        // par-dessus l'ancienne version sans perdre les profils enregistrés.
        create("wheeltop") {
            storeFile = rootProject.file("keystore/wheeltop-debug.jks")
            storePassword = "android"
            keyAlias = "wheeltop"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("debug") { signingConfig = signingConfigs.getByName("wheeltop") }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("wheeltop")
        }
    }

    sourceSets { getByName("main") { assets.srcDir(webAssets) } }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}
