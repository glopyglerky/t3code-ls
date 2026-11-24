package expo.modules.t3nativecontrols

import androidx.annotation.Keep

@Keep
internal object T3OutboxDelivery {
  private val linked by lazy {
    try {
      System.loadLibrary("t3_outbox")
      true
    } catch (_: UnsatisfiedLinkError) {
      false
    }
  }

  private external fun resolveV1(facts: Int): Int

  fun resolve(facts: Int): Int {
    if (!linked) return -1
    return try {
      resolveV1(facts)
    } catch (_: UnsatisfiedLinkError) {
      -1
    }
  }
}
