# The engine's JNI methods (src/main/java/com/card3d/Native.kt, crates/card3d-ffi/src/android.rs) and
# the exceptions it throws by name.
-keep class com.card3d.Native { native <methods>; }
-keep class com.card3d.Card3DException$* { <init>(java.lang.String); }
