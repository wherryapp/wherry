// RingGate on the JVM: a release path (allowPlaintext = false) never
// forwards a call kind without `e`, and an `e` that does not open is
// refused rather than forwarded as it arrived.

package app.wherry.push

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class RingGateTest {
  private val ring = mapOf(
    "k" to "call_ring", "call" to "c", "conv" to "v", "dev" to "d", "exp" to "1", "dsig" to "s",
  )
  private val opened = mapOf("w" to "1", "k" to "call_ring", "call" to "c")

  @Test fun plaintextRingIsRefusedOnTheReleasePath() {
    val decision = RingGate.decide(ring, allowPlaintext = false) { fail("nothing to open"); null }
    assertEquals(RingDecision.Refuse("unencrypted"), decision)
  }

  @Test fun plaintextRingEndedIsRefusedOnTheReleasePath() {
    val ended = mapOf("k" to "ring_ended", "call" to "c", "why" to "cancelled")
    assertEquals(RingDecision.Refuse("unencrypted"), RingGate.decide(ended, allowPlaintext = false) { null })
  }

  @Test fun plaintextRingIsForwardedOnlyWhenTheDebugReceiverAsks() {
    assertEquals(RingDecision.Forward(ring), RingGate.decide(ring, allowPlaintext = true) { null })
  }

  @Test fun encryptedRingIsForwardedAsItsOpenedFields() {
    val decision = RingGate.decide(mapOf("k" to "call_ring", "e" to "body"), allowPlaintext = false) {
      assertEquals("body", it)
      opened
    }
    assertEquals(RingDecision.Forward(opened), decision)
  }

  @Test fun unopenableRingIsRefusedEvenWhenPlaintextIsAllowed() {
    val data = mapOf("k" to "call_ring", "e" to "body", "call" to "outer")
    assertEquals(RingDecision.Refuse("unopened"), RingGate.decide(data, allowPlaintext = true) { null })
  }
}
