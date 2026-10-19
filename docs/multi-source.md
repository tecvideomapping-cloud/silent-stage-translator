# Multiple event sources

An event accepts up to 8 authenticated host connections by default. MAX_EVENT_SOURCES sets a whole-number ceiling from 2 to 16. Idle connected workstations count toward this limit. Existing event ownership, entitlement and session revocation checks apply to every connection. Authorized operators in the event can rename their own device and mute or unmute event inputs.

## Media and identity

Updated participants request multiAudio=1. Each binary packet has an envelope: 0xAB, one byte containing the ASCII source-ID length, source ID, then the existing 0xAA audio frame. Each source gets independent scheduling, buffering and decoding. Web Audio mixes sources into the participant volume graph with peak limiting, rather than concatenating simultaneous packets on one timeline. Disconnect, stop and mute events clear only the affected source.

ADPCM input is decoded once on the server and routed as PCM at its native rate. Decoder state continues advancing during mute; new host connections reset encoder state. This prevents a late listener, mute interval or source change from starting ADPCM with unrelated predictor state. Older participants receive one input and an update notice; they never receive an unrecognized envelope.

Cloud STT uses a distinct session per host. One local recognizer or one disconnect must not close another host's session. Segment and turn IDs include the host connection ID; names and identity accompany captions, translations and saved transcripts. Translated voices remain queued in recognition order; original sources can overlap.

## Metering and distribution

Managed events reserve the same existing five-second time block for all their sources, transactionally, using event.broadcastBudgetUntil. Device concurrency and reconnects within that block do not multiply the event debit. Concurrent separate events still consume independently.

Redis presence includes source metadata and listener capabilities. Moderation is routed to the connection's owning process, which enforces mute before audio, transcription and billing. Cross-event target IDs and listener moderation messages are rejected. Additive nullable source_id and source_name transcript columns preserve earlier records.

## Validation

scripts/multi-source.test.js covers source framing, independent STT, moderation, event isolation, source limits, native ADPCM duration, saved/exported identity and shared metering. scripts/room-bus.test.js includes an isolated serialized cross-instance routing/control test; the live Redis integration is optional. Existing source, clock, entitlement, export and security suites remain applicable.
