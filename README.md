# Whistle

A chaotic double pendulum carries a whistle around a square room. Two microphones
listen. You wear the microphones.

No dependencies, no build step, no server — one HTML file and one JS file, opened
in Chrome.

**[Try it live →](https://thesigns.github.io/Whistle/)** — put headphones on first.

## The idea

Hang a double pendulum in the middle of a square domain and tie a whistle to the
end of it. Put a microphone on the left and one on the right, feed the left one
to your left ear and the right one to your right ear, and let the thing swing.

Everything interesting follows from one fact: **sound takes time to arrive**. The
whistle is never the same distance from both microphones, so the two ears hear
the same whistle at different moments, at different volumes, and — because the
whistle is moving — at *different pitches*. The pendulum is chaotic, so the
pattern never repeats.

The domain can be anywhere from 1 m to 1 km across. At 1 m it is a desk toy. At
1 km the sound takes three seconds to cross the room, the echoes arrive like
distant thunder, and the two ears drift completely out of sync.

## Running it

The hosted copy is at <https://thesigns.github.io/Whistle/>.

To run it locally, double-click `index.html`. That is the whole install.

If Chrome refuses to start the audio engine from `file://`, serve the folder:

```
python -m http.server 8000
```

then open <http://127.0.0.1:8000/>.

Click **Start audio** — browsers will not produce sound until you interact with
the page. **Headphones are the point**; on speakers the left/right separation
that the whole experiment is built around collapses.

## What the model actually does

All of it — the physics and the audio — runs inside a single `AudioWorklet`, at
the sample rate. The main thread only sends parameters down and draws the
positions that come back. That split matters: the delay from whistle to
microphone has to follow the whistle sample by sample, and nothing on the main
thread runs often enough to do that.

**Propagation.** The whistle writes into one delay line. Each microphone reads
back out of it at a position set by its current distance to the whistle, divided
by 343 m/s. Fractional positions are interpolated.

**Doppler.** Not modelled. It falls out for free: when the whistle moves, the
read pointer advances at a rate other than 1.0, and a delay line read faster or
slower than it is written *is* a pitch shift. Push the time scale high enough and
the read pointer goes backwards, which is what a source outrunning its own sound
actually sounds like.

**Walls.** Image-source method. An image at index `(i, j)` is the whistle
mirrored `|i|` times across the vertical walls and `|j|` times across the
horizontal ones; each one is just another tap on the same delay line, attenuated
by the wall reflection coefficient raised to the number of bounces. Reflection
order 2 gives 13 sources, order 4 gives 41. Taps quieter than the noise floor are
skipped, so an anechoic room costs almost nothing to render.

**Air absorption.** Air eats high frequencies roughly in proportion to the square
of the frequency — about 0.5 dB per 100 m at 1 kHz, far more at 8 kHz. Every path
gets its own one-pole low-pass whose −3 dB point sits where that path has lost
3 dB: 11 kHz at 5 m, 770 Hz at a kilometre. Because reflected paths are longer
than the direct one, distant echoes go dull on their own — that behaviour is not
special-cased anywhere.

**The whistle.** A strong fundamental plus three fast-decaying harmonics, with a
band of breath noise from a resonant filter tuned to the same pitch, and a slow
warble in both pitch and amplitude. Real pea whistles never hold still.
Optionally, the pitch tracks how fast the whistle is moving, normalised against
√(2gL) — physically unmotivated and it sounds strange, which was the point.

**The pendulum.** Full double-pendulum equations, RK4. The integration sub-step
scales with the pendulum's own natural period, so a 400 m arm is not integrated
with the same tiny step as a 20 cm one.

## Controls

| Control | Range | Notes |
| --- | --- | --- |
| Domain size | 1–1000 m | Logarithmic. The arms scale with it. |
| Wall reflection | 0–0.98 | 0 is anechoic, 0.98 is a tiled swimming pool. |
| Reflection order | 0–4 | 1, 5, 13, 25 or 41 image sources. |
| Air absorption | 0–4× | 1× is roughly realistic; 0 turns the low-passes off. |
| Arm span | 5–45% | Total pendulum length as a fraction of the domain. |
| Time scale | 0.05–20× | See below. |
| Gravity | 0.5–50 m/s² | Physically equivalent to time scale squared. |
| Damping | 0–0.5 /s | Zero runs forever. |
| Base frequency | 150–4000 Hz | |
| Harmonics | 0–1 | 0 is a pure sine, 1 is shrill. |
| Breath noise | 0–1 | The airy part of the whistle. |
| Warble | 0–1 | Pitch and amplitude wobble. |
| Speed to pitch | 0–2 | Pitch follows the whistle's speed. |
| Master gain | 0–1 | Starts low on purpose. |
| Crossfeed | 0–0.5 | 0 keeps the two microphones strictly separate. |

Drag the microphones anywhere in the domain. **Space** pauses the pendulum — the
whistle keeps sounding, so you can hear the static field and move the microphones
through it. **R** randomises the starting angles.

The time scale deserves a warning. Sound always travels at 343 m/s in *real*
time, so speeding up the simulation does not speed up sound — it speeds up the
whistle *relative* to sound. That slider is really a Doppler control, and past
about 5× in a large domain the whistle goes supersonic.

## Things worth trying

- **Anechoic vs. hard walls.** Set reflection to 0, listen, then run it to 0.95.
- **1 km, hard walls, reflection order 4.** Echoes arrive for tens of seconds.
- **Mute the whistle** while the room is reverberant, and listen to the tail
  ring out on its own.
- **Time scale to 20×** and watch the Mach number in the readout.
- **Park a microphone next to the pendulum's anchor** and the other in a far
  corner: one ear gets the whistle dry, the other gets the room.

## Not modelled

Microphone directivity (both are omnidirectional), diffraction, the pendulum's
own acoustic shadow, wall materials with frequency-dependent absorption, and any
head-related transfer function — the two channels are raw microphone signals, not
a binaural render.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Markup, styles, and the `AudioWorklet` source |
| `app.js` | Main thread: controls, parameter plumbing, the canvas view |

The worklet source lives inside a non-executing `<script>` tag in the HTML rather
than in its own file, because `addModule()` cannot fetch a sibling script under
`file://`. `app.js` turns that block into a Blob URL at startup, which is what
keeps the double-click-to-run promise.

## License

MIT — see [LICENSE](LICENSE).
