plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "ly.almasar.pos"
    compileSdk = 35
    defaultConfig { applicationId = "ly.almasar.pos"; minSdk = 24; targetSdk = 35; versionCode = 1; versionName = "1.0" }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    val cx = "1.3.4"
    implementation("androidx.camera:camera-core:$cx")
    implementation("androidx.camera:camera-camera2:$cx")
    implementation("androidx.camera:camera-lifecycle:$cx")
    implementation("androidx.camera:camera-view:$cx")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.12.1")
}
