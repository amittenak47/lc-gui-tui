# Changelog

All notable changes to `lc` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed — the board stops being able to trap the pen

- **A shape-tool drag could carry the whole note off screen.** The page frame is
  scaffolding and it was selectable, so a drag that started a few pixels off its
  mark grabbed the page instead of drawing on it — with no keyboard to undo it.
  It is locked now, as the markdown frame already was, and boards saved by older
  builds are locked on open. Excalidraw's context menu goes with it: a long
  press opened the canvas settings, and that sheet is what handed the next drag
  to the canvas.

- **An arrow could not be escaped or deleted.** A click rather than a drag opens
  a multi-point line, every further tap adds a bend, and the exits are keys this
  device does not have. A line in progress is also not *selected*, so the trash
  never appeared over it. Now a drag draws a shape, a tap draws nothing, and
  whatever the gesture leaves is selected on release. Changing tools closes an
  open line too.

- **Double-tapping with select or a shape tool raised the keyboard**, because
  Excalidraw turns a double click on empty canvas into a text element. Blocked
  unless the text tool is genuinely up.

- **The trash sat over the top-right corner of what it deletes**, covering most
  of a small shape. It sits outside the selection now, falling back around the
  box when the corner is off screen, and it measures an arrow by its points
  rather than its stale width.

- Shape tools stay equipped after placing a shape. Three rectangles was nine
  gestures.

### Fixed — the pen's dials mean what they say

- **Stroke smoothing had three settings, not a hundred.** Rounding was bought in
  whole passes through `ceil`, so measured across the slider the stroke changed
  at 55% and at 90% and nowhere else — and under the bottom quarter the
  simplifier was pinned at its storage floor, so 8%, 17% and 25% produced
  byte-identical ink. The last pass is partial now: the corner cutter takes its
  cut ratio, so 1.4 passes is one full pass and one cutting 40% as deep. Same
  maximum, same point count, continuous end to end.

- **Speed ink's "capsule" was two bugs.** The low-pass over a stroke's pace was
  a five-tap box over the point *index*, tuned on the assumption that five
  stamps span about a nib width — but smoothing *inserts* points, so with it
  turned up the same five taps covered a fraction of the distance they were
  tuned for. That is why the beads got worse with the one setting that should
  have helped. The window is in nib widths of travel now, and there is a slope
  limit on top, because a bead is a width discontinuity and averaging only ever
  makes a shorter step. The width multiplier also ran negative past neutral at
  full strength, which is not a thin line but whatever the hairline floor
  happens to be; it has a floor.

- **The nib was a different size on a document than on the pad**, because the
  slider was in scene units and a document opens fitted to a reading column. It
  is in screen pixels now, converted at stroke start — ink still stores scene
  units and still scales when the page does.

### Fixed — saving, and getting back what you saved

- **A restored board opened with a gap above the writing**, and came right the
  moment the pen touched down. The page grows to what is written on it, but only
  from the ink layer's change handler, which a restore does not fire — so the
  camera fitted a one-screen frame around several screens of notes. Restoring
  ink grows the page now, and every restore path puts the ink in before the
  camera settles.

- **Deleting a notebook was one tap while opening one needed a hold.** Both are
  holds now.

- **Discard reads Exit when there is nothing to discard**, so leaving a saved
  board does not ask anyone to confirm throwing away work that is not at risk.

- **Ink drawn over a wide codeblock slid off the words**, because the block was
  the one thing on the page allowed to scroll its own contents. While a drawing
  tool is up nothing does; the block shows its full width and the board pans.

- Banners were see-through over live ink, and the notice variant was worse than
  translucent — its background was invalid CSS, so it silently inherited the
  error banner's pink.

### Added — a highlighter, autosave, and an eraser that is a setting

- **A real highlighter.** The tool of that name sweeps a region and hands it to
  the coach, which is useful and is not what anyone reaches for when they want
  to highlight. The new one is a chisel: one width, one alpha, no pressure and
  no pace, composited `multiply` so writing stays legible under it. It takes its
  colour from the pen's palette; the sweep is relabelled for the job it does.

- **Autosave is in Settings.** It has always run, every three seconds, and has
  never been visible — a bad combination for the one feature whose whole value
  is confidence. Off is allowed.

- **The eraser's crosshair is gone** (the ring's edge is what the hand aims
  with) and what it removes is a choice: rub pixels out, or take whole strokes.

- **Hold the header's pad icon to save**, rather than tapping through a menu.

- **Android's back-gesture strips are handed back while writing.** A downstroke
  started too near the left or right edge used to leave the app instead of
  leaving ink. The bottom edge is deliberately left alone.

- Server and model polling drop from roughly twenty requests a minute to between
  two and six.

### Changed — chrome that stays out of the way without going missing

- The toolbar and icon stack sit on the coach panel's top edge and ride it up,
  instead of being moved clear of the sheet and then hidden anyway.
- The "Scratchpad" heading is no longer a locked text element on the first page
  of every notebook; the notebook announces itself over the board and fades.
- Hidden mode's wake corner has a visible dot, a tap anywhere on the board wakes
  the controls, and annotate mode never hides the tools being used.

### Added — Markdown Ink

- **Annotate a markdown file the way you annotate a scratchpad.** A markdown
  icon sits immediately left of the scratchpad's paper: tap it to pick a `.md`
  file, hold it for documents already annotated. The file opens as the page —
  scrollable like a note in Obsidian, read-only, never written to — and the
  whole existing toolbar works on top of it: pen, eraser, shapes, text, colours,
  undo.

  The document is *paper*, not a viewer. It has no scrollbar of its own: it lays
  out at full height inside the page frame and rides the board camera, so a pan
  moves the words, the shapes and the ink together as one thing. An inner
  scroller would have been far easier and completely wrong — the ink would slide
  off the words the moment you scrolled. The text is laid out once at the page's
  scene width and then *scaled* by the camera, one affine transform shared with
  Excalidraw and the raster ink, so the three cannot drift apart at any zoom.

  Annotations are keyed by a hash of the markdown's content rather than its
  path, so reopening the same file finds its ink again wherever the file has
  moved to. Save, discard and quick-leave follow the scratchpad's contracts
  exactly, including the two that were bugs there until recently: nothing is
  committed until something has been drawn, so opening a document to read it
  leaves no trace, and an explicit Save re-baselines so a later Discard rolls
  back to the save rather than past it.

  **Discard only ever throws away annotations.** The file on disk is opened
  read-only and nothing in this feature can write to it.

  **Reading and annotating are a toggle**, sitting with the eye and the
  lined-paper switch in the map chrome and wearing the same card. A board built
  for a one-page problem gives you free 2D pan and wheel-to-zoom, which is right
  for something you are sketching on and wrong for something you are reading
  down — every scroll of a trackpad would rescale the words. Reading mode makes
  the wheel scroll and keeps a drag in its column, so you cannot wander sideways
  off the text; Ctrl/Cmd+wheel still zooms, and the pen still draws, so nothing
  is taken away. A document opens in reading mode, because you opened it to read
  it.

  **Annotations travel.** Export writes a `.lc-ink.json` sidecar to keep beside
  the `.md`; import reads one back. Import refuses a sidecar drawn over
  different text rather than scattering ink across words it was never placed
  on. And a file that has been edited since it was last annotated now says so
  instead of quietly opening blank — the old set stays under Recent, which
  turns "where did my annotations go" into a sentence that explains itself.

  Not in v1: editing the markdown, multipage documents, the coach, and writing
  the sidecar to disk automatically — export is explicit, so nothing appears
  next to the writer's files without them asking.

### Changed — the page scrolls, the ink rides it

- **A coast no longer repaints the ink sixty times a second.** Reading scroll
  already left Excalidraw's camera alone — pushing `updateScene` per sample is
  what held the board near 30fps — and moved the markdown with a CSS transform.
  The ink did not get the same deal: it is a viewport-sized bitmap, so every
  sample went through `syncCamera` → clear → re-blit the visible tiles, and
  Excalidraw's own canvas simply froze and snapped at the end. Which is to say
  the ink was behaving like a layer floating over the *viewport* on a board
  whose whole premise is a layer bound to the *page*.

  It is bound now. A gesture leaves everything painted for the camera it opened
  on and slides it: the ink bitmap, Excalidraw's two canvases, the lined rules
  and the page title all take the same translate, published as a pair of custom
  properties the stylesheet reads. That is a compositor job. Nothing rasterises,
  nothing lays out, nothing reconciles a scene until the finger comes off — one
  paint and one `updateScene` on the settle, where before there were sixty of
  each, and the marks stay glued to the words they were written on because they
  are now moving for the same reason the words are.

  A translate can only borrow against a screenful that has already been painted,
  so half a viewport of travel mid-gesture rebases: commit the camera, repaint
  once, carry on riding from there. A zoom does not translate at all — a pinch
  rescales every stamp — and falls back to the repaint path it always used.

- **A wide code block scrolls sideways.** It had `overflow-x: auto` and a
  scrollbar, and no way on earth to reach it: the markdown layer is
  `pointer-events: none` so a pen lands on the ink rather than the text, and the
  reading gatekeeper takes every pointer on the board and turns it into a page
  pan. The block gets its pointers back while reading — only the block, never
  the prose — and the gatekeeper now waits for the gesture to say which way it
  is going, the way it already did for the code dock: mostly sideways scrolls
  the code, mostly down still pans the page, and the axis that wins keeps the
  gesture to the lift. Trackpads and shift+wheel work too.

### Added — the ink palette is yours

- **Hold a swatch to change what colour lives there.** The six swatches are
  positions, not colours — slot 0 is "the dark one you write with" — so an
  override changes what sits in a slot without changing what the slot is for.
  The authored colours stay the defaults: a slot nobody has touched keeps its
  own forever, setting one back to its original clears the override rather than
  storing it, and holding the hub in the middle of the ring restores the lot.
  Light and dark keep separate palettes, because the pale set is unreadable on
  paper and the dark set vanishes on a black board, so a choice made on one
  must not follow you to the other.

  The hold is longer than the one that opens the ring: opening is something you
  do constantly and editing is something you do twice, so the rarer gesture is
  the one that has to be meant. The picker itself is the platform's own, which
  is the one that works in the tablet's WebView and on the desktop without
  shipping a second colour UI.

### Changed — replying to the coach

- **A quoted message is a thread, not a paste.** Quoting used to copy the
  coach's whole answer into the composer as `>` prose, so replying to a long
  turn meant scrolling past a copy of it to reach your own cursor — and the copy
  was all that survived, since the sent message had no idea what it was
  answering. A reply now holds a reference: the quoted turn shows as a chip
  above the composer while you write and as a stub inside the bubble once you
  send, and tapping the stub scrolls back to the original and flashes it. The
  coach is told what is being replied to as well, so a bare "why?" no longer
  arrives without a subject. Threads survive a reload.

- **The composer is a paragraph tall.** A question to a coach is usually a few
  sentences, and the box was sized like a search field.

### Fixed — Discard now discards

- **The scratchpad's Discard button did nothing, and Save could not be
  disproved.** The board autosaves every three seconds, so by the time anyone
  reached the leave dialog their writing was already committed to the notebook
  library — and Discard then simply navigated away, leaving intact exactly what
  it offered to throw out. Save looked like it worked for the same reason: the
  autosave had already done it, whichever button you pressed. A session now
  records what the library held when the notebook opened, and Discard restores
  it — putting the entry back byte for byte, or deleting the notebook outright
  when the session opened blank and the autosave is the only reason it exists.
  Restoring keeps the original timestamp, so a discarded session does not leave
  a notebook sitting at the top of the library looking freshly worked on. An
  explicit Save re-baselines, so discarding later rolls back to the save rather
  than past it. The autosave keeps its real job — surviving a crash or a closed
  lid — without deciding what the writer meant to keep.

- **A blank notebook no longer joins the library on its own.** The first
  autosave tick of a fresh scratchpad had nothing to write but the empty
  template and wrote it anyway, so opening the scratchpad and changing your
  mind left a permanent entry three seconds later. There is nothing to protect
  there — a crash on a blank page loses a blank page — so untouched notebooks
  are now skipped.

- **Two notebooks created in the same millisecond no longer collide.** Ids came
  from the clock alone, so the second notebook took the first one's id and
  overwrote it: the library losing an entry where it should have gained one.

### Changed — getting in and out of the scratchpad

- **The paper icon is tap for a new notebook, hold for the library.** Starting
  to write is the common case by a wide margin and it was behind a dialog whose
  other option nobody wanted most of the time. The hold fills like every other
  hold in the app.

- **Leaving an untouched notebook no longer asks.** A notebook nobody wrote in
  is not a decision worth interrupting for: the exit leaves straight away and
  takes the autosave's placeholder with it. Anything written still gets the
  menu, and the exit control stays a tap.

- **A saved notebook is one row with the bin inside it.** The delete button was
  a second, unlabelled card sitting beside the entry, with nothing to say which
  notebook it would remove. The row is now the entry — the load target fills
  everything the bin leaves, so the big easy thing to hit is the one you meant
  and the destructive one is tucked in the corner behind its own hairline edge.

### Added — you can see what zoom you are at

- **A zoom readout in the middle of the board.** Zooming a page of handwriting
  gives the eye nothing to judge scale by: the ink grows and shrinks, but there
  is no ruler and no chrome, so "how far in am I" had no answer without looking
  away at the toolbar. A translucent pill now names the level where the eye
  already is and fades out shortly after the gesture stops. It is written
  imperatively — one text node, one class — because a readout driven by React
  state would have re-rendered the whole board on every frame of a zoom, making
  it part of the problem below.

### Fixed — zoom and pan on a page with writing on it

- **A held zoom button no longer stutters.** Every frame of a zoom was paying
  for: two `getBoundingClientRect()` calls to re-measure a box only a resize can
  move, a React re-render of the board and its toolbar to update the zoom
  percentage, a duplicate code-slot report, and up to 5ms of ink-tile
  rasterisation for a camera that had already moved on. Worse, a zoom crosses a
  tile level every √2, and crossing one invalidates every visible square at
  once — so the frames that stuttered hardest were the ones where the whole
  screen wanted rebuilding mid-animation. The box is now measured once and
  re-measured only when the board actually resizes, the percentage reaches React
  only after the gesture settles, and a gesture pins the tile level it opened on
  so its frames are pure blits. The settle re-levels and the background pass
  sharpens. The pin yields if the zoom runs more than an octave from it, where
  holding on would cost more squares than it saves.

- **Panning a written page is a blit again.** The same per-frame measuring and
  rasterising sat on the pan path, and camera repaints were not coalesced: the
  bounds clamp answers a scroll event with `updateScene`, which raises another
  scroll event, and both repainted — two full clear-and-blits for one frame the
  screen can only show once. Repaints now land at most once per frame.

- **A flick coasts instead of springing back.** The inertia integrated velocity
  into the clamp every frame, so a coast that reached a boundary was thrown out
  and yanked back sixty times a second — the bounce. On an axis whose content
  fits the viewport the clamp does not return the edge but the *centre*, which
  is why a flick there looked like it reverted to where it started: it was being
  re-centred on every frame of the coast. An axis that the clamp refuses to move
  now stops coasting, and the coast no longer double-clamps against the scroll
  handler.

- **Committed strokes are thinned even with smoothing off.** A stroke is stored
  as the stamp chain the move path builds — points a fraction of a nib apart,
  dense for stamping and pure overhead once the stroke is a polyline. The
  Ramer–Douglas–Peucker pass that would have thinned them only ran when the
  writer had asked for smoothing, so smoothing-off and live-smoothing pages
  carried every stamp forever. There is now a storage floor well under the line
  — a fifteenth of a nib, far below the smoothing tolerance — that runs
  regardless. It is paid once at the lift and refunded on every tile
  rasterisation for the life of the page.

### Changed — the ink log now says where the delay was

- **`[ink]` stroke lines carry `stale`, `gap` and `frame` alongside `paint`.**
  The paint latency alone could not tell a stall from a smooth stroke, and it
  failed in the flattering direction. It is measured against the dispatched
  `pointermove`'s timestamp, and a dispatched move carries the *newest* sample
  in its batch — the older ones are in `getCoalescedEvents()`. Block the main
  thread for a third of a second and the browser does not hand over a third of
  a second of queued moves; it coalesces them into one move stamped a
  millisecond before the handler finally runs, and the freeze prints as a 2ms
  paint. The three new numbers are the ones that can see it: `stale` is the age
  of the oldest sample in a batch when the batch was handled, which is how far
  behind the hand the ink really was; `gap` is the longest stretch with no move
  handled at all, which is the stall itself; `frame` runs from the draw calls
  returning to the start of the next animation frame, because a canvas draw
  only queues work, and ink drawn on time but presented late is a compositor
  problem rather than an input one. The coalesced count was never a delay:
  those samples ride in on the same event and are stamped in the same
  synchronous loop, so a higher count means more of the stroke was drawn, not
  that any of it was drawn later.

- **A stalled stroke now names what stalled it.** `gap` says the thread was
  gone; a `blocked` column says what took it, built from the browser's own
  long-task reporting and charged to the stroke only for the overlap, so a task
  that straddles pointerdown costs the stroke its tail rather than its whole
  duration. It appears only on strokes that had one, which keeps the clean
  lines readable and makes the bad ones obvious at a glance.

### Fixed — one hand on the page at a time

- **The autosave no longer lands in the middle of a letter.** Board persistence
  runs on a three-second timer, and saving means walking every element and every
  ink point on the page and handing the lot to `JSON.stringify` on the main
  thread — out to the daemon for a problem, into `localStorage` for a
  scratchpad, where the write itself blocks. On a timer that cost lands wherever
  it lands, and every so often that is under the nib: the stroke stops partway
  through and the next letter feels like it is catching up. It reads as random,
  but it is not — a long stroke takes longer to write, so the tick is likelier
  to land inside an "e" or a "p" than inside an "i", and the cost grows with
  everything already on the page. The save now waits for a gap in the writing:
  never with the tip down, and not between letters either, with a ceiling so a
  long unbroken burst still gets written out.

- **A letter that disappears when you lift the pen, and comes back a letter
  later.** A square the frame budget could not rasterise falls back to a cached
  zoom level so the writer sees something soft rather than a hole. The level it
  fell back to was the last one at which *every* visible tile was ready — which
  is the wrong answer precisely when it is needed, because after a few complete
  frames that is the level you are already on, and a fallback from a level to
  itself is refused. The square was left empty. Empty is not "a bit blurry":
  the overlay is cleared before the blit, so an unfilled square is committed
  ink missing from the screen. Lift the pen, the commit repaints, one square
  misses, and the letter you just wrote is gone until the next lift repaints it
  back. It now falls back to whatever is actually cached, nearest level first.
- **A stroke no longer evaporates when the page is replaced under it.**
  `clear`, `undo`, `redo` and a notebook restore each dropped the in-progress
  stroke's op without telling the pointer path the stroke was over. Every
  sample after that went nowhere and the lift committed nothing — the letter
  absent, with nothing on screen or in the log to say why.

- **A resting hand no longer wrecks the letter under the pen.** The ink layer
  answered to any pointer at all, and with palm reject off a tablet reports the
  heel of your hand as one. So a palm landing mid-word ended the stroke the nib
  was still writing and committed it where it stood; the palm's moves then
  dragged the live stroke off across the page; and the palm lifting committed
  that. One touch could produce all three symptoms at once — a letter that
  stops short, one that has a stray line through it, and one that never seems
  to register. A stroke now belongs to the pointer that started it until that
  pointer lifts, and everything else is ignored while it is down. The
  stranded-stroke recovery still runs — it just asks first whether the pen is
  genuinely gone (has it lost capture?) rather than assuming the second touch
  means it is.
- **The pause after every pen lift, and why it grew.** Committing a stroke took
  an undo snapshot, and the snapshot deep-copied every point of every op on the
  page. A stroke is stamped several times per line width, so a page of writing
  is tens of thousands of points, and all of them were copied on every single
  lift — the fortieth letter copying thirty-nine strokes' worth, with up to
  forty such copies kept alive at once. Nothing ever writes to a committed
  stroke, so the snapshot only ever had to remember *which* ops were on the
  page. It now does, and the lift costs the same on a full page as on an empty
  one.
- **`setPointerCapture` failing is no longer silent.** It was caught and
  discarded, which meant the layer carried on as though it had capture: the
  moment the nib crossed the edge of the overlay the moves stopped arriving and
  the rest of the stroke was written to nothing. If capture is refused the
  pointer is now followed on the window for the length of that stroke instead.
- **A smoothed stroke keeps the pace it was written at.** The corner cutter
  built its new points from position and pressure only, so every interior point
  of a speed-ink stroke lost its slowness on the lift and fell back to a neutral
  pace. The stroke was laid down with its swells and starves and then flattened
  to an even line the instant the pen came up — the letter changing shape under
  your hand. Pace now rides through the filter the way pressure does.
- **Erasing no longer forces a layout per pointer sample.** The brush ring
  hit-tested the pointer against the canvas box on every event — two
  `getBoundingClientRect()` calls, flushing style and layout for the whole
  board, ahead of the animation frame that was supposed to be batching the
  work. This is the same fault the pen's move handler had; the ring now does
  its reading once a frame, inside the frame.
- **A press that draws nothing says why.** Six early returns in the pointer path
  each ended a `pointerdown` silently, so a letter that failed to appear looked
  identical to one that was never pressed. With `lc.ink.metrics` on, each one
  now logs its reason and counts on `__lcInkMetrics.summary().notes`.

### Fixed — writing that stays as fast as it started

- **The pen stops getting slower the more you write.** This was the "smooth for
  a few letters, then it starts lagging" one, and it was in the commit rather
  than in the drawing. Lifting the pen dropped every cached tile the new stroke
  touched, and the repaint that followed rebuilt them by replaying every stroke
  those tiles overlap — so the tenth letter in a square replayed nine, the
  fortieth replayed thirty-nine, and the hitch grew without bound across a page.
  A freshly committed stroke is chronologically last, so it is now composited
  straight onto the tiles instead: one stroke's work, whatever is already
  written underneath it.
- **Strokes stop going missing.** Two causes, both of them real. When that
  rebuild blew its 5 ms frame budget the tile blitted empty, and the background
  pass that finished it was thrown away if the pen was already back down — so a
  letter could sit invisible for as long as you kept writing. And a stroke whose
  `pointerup` never arrived — a stylus leaving proximity, a capture taken by the
  system — was silently overwritten by the next `pointerdown` instead of being
  committed. Both are now closed out; `lostpointercapture` ends a stroke too.
- **A forced layout on every pointer sample.** The move handler called
  `getBoundingClientRect()` on the ink canvas per event, flushing style and
  layout for the whole board — Excalidraw and toolbars included — before it
  could draw. The box is frozen for the stroke anyway, so it is now read once at
  `pointerdown`.
- **A full tile blit at the exact moment the nib lands.** Every `pointerdown`
  repainted the committed page under the frozen camera. Between two letters
  nothing has moved and the pixels on screen are already the answer, so that
  frame is now skipped unless something actually changed.

### Fixed — the size wheels reach their own ends

- **The toolbar wheels land on their first and last value.** Pen, eraser, font
  and ink all scroll to min and max perfectly well — the value was right, the
  stroke was right — but the wheel never looked like it got there. At the bottom
  of the range the selection band sat on `2` while `1` hung below it, and at the
  top it sat on `99` with `100` half cut off above; the end of the range read as
  unreachable. The wheel already pads the list with empty slots at both ends so
  the ends can centre, and those pads were being emitted. They were collapsing.
  Five 22px slots share a 44px window, so every slot is asked to shrink: one
  with a number in it refuses, because its line box is its minimum height, but
  an empty pad has nothing to hold it open and goes to zero. The stack lost a
  slot's height at whichever end the pads were on, and slid up by exactly that
  much. The slots no longer shrink, so min and max centre like any other value.

### Added — two ways to make the ink yours

- **Speed ink** (Settings → Personalise). A slow nib lays down more than a fast
  one: ink pools where you dwell and thins where you run. Pressure cannot do
  this on its own — a hand presses hardest at the *start* of a stroke and writes
  fastest through the middle. Off by default; the pace is normalised on screen,
  so zooming in does not turn every stroke into a slow one, and it is stored on
  the point, so a replay, an export and a re-render all reproduce what was
  written.
- **Smoothing while you write.** The strength dial now has a *when*: on the lift
  (unchanged, and still the default) or under the nib. Live smoothing looks
  steadier in the moment and costs lag — pull hard enough and a tight loop like
  an "e" closes up on itself, because the nib is still climbing into the bowl
  when the hand has come back down. Two things keep the whole dial usable rather
  than just its bottom half: the pull is a time constant rather than a
  per-sample weight, so a 240 Hz stylus and a 60 Hz mouse are filtered the same
  amount over the same stretch of paper; and the top of the dial is two frames
  of lag, deliberately short of where loops start closing. The lift lands the
  nib where the pen actually left the page.

### Changed — a nib that lasts a word, not a letter

- **Ink fullness reaches much further before it dries.** An empty dial was 14
  nib widths of writing, which is about a quarter of a letter — so the whole
  bottom of the dial gave out inside the first character and read as broken
  rather than as dry. The base is now 150: the empty end fades over a word, the
  middle over a line, three-quarters over several, and the top still does not
  dry at all. The default (100%) is unchanged.


### Added — captures you can see happen

- **Countdown, shutter, and a toast that names the file.** A capture used to be
  silent: the board froze for a beat, an image appeared, and where the PNG went
  — if one was written at all — was something you went and looked for. There is
  now a countdown you can tap through (Settings → Personalise → Capture
  countdown, off / 3s / 5s), a shutter flash at the moment of the export, and a
  toast reading out the real save path. Region capture behaves the same as the
  whole board, and "Added to the board" is reported too, for when auto-save is
  off.
- **Share actually shares.** It could not before: `navigator.share` is gated on
  a secure context and this WebView is served over cleartext http so the LAN
  daemon stays reachable, so the API was simply undefined. Sharing is now a
  native Android intent, through the plugin that already writes to MediaStore —
  a cache file behind a FileProvider, so sharing does not also leave a copy in
  the gallery. Off Android the app saves to Photos and says where instead.
- **A capture folder you pick.** A new save destination taking an absolute path
  (with `~`), alongside Photos and Downloads. Desktop already wrote to
  `Pictures/lc`; what was missing was any sign that it had.

### Fixed — board chrome

- **The capture menu matches the shapes menu.** It had a box of its own, and
  was never wired into the press-outside/Escape dismissal, so it stayed open
  behind the next stroke.
- **Hand/Select loses its captions.** Two entries with a line of prose each made
  the flyout twice the height of the shapes one; the descriptions are tooltips.
- **The chrome eye gets its card back.** It carried `lc-map-btn` as well as its
  own class, and the former is declared later in the stylesheet — so a
  transparent background and squared corners won.
- **Reset stops flashing the authored layout.** It seeded the template and
  fitted the camera a frame later, so the old size painted once before the
  resize. Both now land in the same paint.

### Changed — the pen rewritten around tiles, runs, and a nib that dries

- **Pan and zoom stop stalling on a full page.** Committed ink used to sit in
  one viewport-sized bake keyed on zoom but not scroll. Panning slid it under a
  CSS translate, so the ground the translate exposed was blank until you let go
  and the whole page replayed at once; zooming replayed every stroke on the
  board before it could paint a single frame. Ink is now rasterised into fixed
  squares of scene space, cached per zoom level on a half-power-of-two ladder,
  and the visible ones are blitted each frame — the way a map renders. Panning
  reuses the tiles it has and rasterises only what it exposed. Zooming blits
  the tiles it has, scaled, and sharpens them from a background pass, so a
  level change is a moment of softness rather than a stall. Rasterising is
  budgeted per frame and resumes across frames, and a tile only replays the
  strokes whose bounds reach it. Committing a stroke drops the two or three
  tiles under it, not the page.
- **A stroke is painted as runs, not as one path per segment.** That was a
  canvas submission per point, with a stamp every fifth of a line width. It was
  also why ink looked soft: consecutive round caps overlap, so at any alpha
  below 1 every overlap composited again and a stroke came out solid down the
  middle with a wide halo on both edges. A constant-width stroke is now a
  single `stroke()` — one coverage mask, one composite, exact alpha, crisp
  edges. Erase stamps are one path per wipe instead of one fill per stamp.
- **The Ink dial is a nib charge, not a flat opacity.** Every stroke starts
  full and fades with how far it has written; lifting the pen dips it back in.
  The dial sets how long the charge lasts, and at 100% the nib does not dry at
  all. Pressure keeps a floor, so the light ends of a fast stroke stay on the
  page instead of fading to nothing.
- **The finest tip draws a hairline.** The width dial was a flat multiple, so
  its bottom notch was nearly three device pixels on a retina panel. Tip `n` is
  now `0.9 + (n - 1) × 1.35` scene units, and thin strokes get a device-pixel
  floor so they stay black instead of greying out as you zoom away from them.
- **A tap draws a dot.** Dotting an "i" used to draw nothing.

### Added — stroke smoothing

- **Settings → Personalise → Stroke smoothing.** A slider (default 35%, off at
  0) for how much shake to take out of a pen stroke: drop the samples that
  carry no shape, then round off what is left. It runs when the pen lifts, not
  per sample, so the ink never lags the nib while you write. Capped so the
  smoothed path stays inside the ink the raw one would have laid down.

### Fixed — placing a text box on a tablet

- **The keyboard opens.** Placing a note dropped a box and stopped there. The
  hand-off to Excalidraw's editor was a synthetic double-click, which upstream
  ignores unless the active tool is `selection` — ours sat on the locked text
  tool, so the editor was never created. Excalidraw now stays on `selection`
  while the Text tool is up: we place the element, select it, and double-click
  inside it, which opens and focuses its textarea within the press's
  user-activation window. Press-drag-release keeps the width you drew and
  wraps; a tap gets a box that grows.

### Added — hand inertia, ink fullness, smooth zoom

- **Hand-tool flick coast.** Release a pan flick and the board keeps sliding with
  friction instead of stopping dead.
- **Ink tip vs fullness.** Stroke wheel is nib width; a new Ink dial is max
  laydown (opacity). Stylus pressure drives fullness up to that ceiling, with
  only mild width spread — not width∝pressure. Settings → Personalise →
  Pressure clip (30–100%) remaps hardware press so you need not bury the tip.
- **Faster pan with dense ink.** The ink bake no longer rebuilds every scroll
  frame; the bitmap translates with the camera and recommits when pan settles.
- **Smooth zoom buttons.** +/- retarget an eased zoom animation instead of
  blocky 1.15× jumps.
- **Stroke wheel coarse/fine.** Integer steps by default; hold and drag outward
  for tenths (iPhone-scrub style). Strong flicks cover larger integer ranges.

### Fixed — settings draft, chrome overlays, movable toolbar

- **Settings save only on Save.** Personalise prefs (writing hand, capture
  auto-save, offline merge) no longer write immediately. Save stays disabled
  until something changes; Cancel / backdrop close drop the draft and keep the
  previous values.
- **Error / busy banners overlay the canvas.** They no longer sit in document
  flow under the header, so showing a banner mid-stroke cannot resize
  Excalidraw and scramble ink.
- **Bottom tray stays above the board.** Map controls use a higher overlay
  stack; hiding chrome lets the fitted page reclaim the bottom strip on mobile
  the same way desktop already did.
- **Coach sheet grab bar sits higher.** Peek and sheet lift clear Android's
  home-gesture band so the handle is easier to catch.
- **Toolbar docks and floats.** Long-press the grip, drag anywhere on the
  workspace, drop near the bottom slot for a snap-home animation. Position
  persists until you dock it again.

### Added — the coach shows its work, and stops changing its mind

- **Stages arrive as they happen.** Ask, Review, Draw and Lazy run over the
  session WebSocket, which now carries `run` / `cancel` frames and reports each
  pipeline stage and diagram tool call back to the chat turn that asked for it.
  The chat used to fill that silence with a timer guessing at phases; on a slow
  local model the guess was usually wrong. `POST /coach/*` still works and is
  what `coach.ws_runs = false` puts the UI back on.
- **One approach per board session.** Several approaches are valid on most of
  these problems, and a model that knows three of them could read a half-drawn
  board as a different one each turn. The session now commits to the approach
  the board argues for, and every stage after the claim coaches inside it. Only
  a board that actually changed can move the commitment — and when it does, the
  card says so, with a reason and what carries over. A student who asks to
  switch is honoured immediately.
- **An optional planner.** `llm.modes.planner` catalogs the approach families a
  problem admits, once, and the local coach uses it to recognize what the
  student drew — never to recommend from. It sees the same redacted problem
  `lc ask` does. Off unless `coach.planner_enabled`.
- **An optional check on drawn diagrams.** After a diagram renders, a vision
  model can look at the picture and redraw it once if it does not show what the
  program claims — catching the diagrams that type-check and are still wrong.
  One critique, one redraw, no loop. Off unless `coach.draw_review_enabled`.
- How the coach works, and why, is written down in
  [`docs/coach.md`](docs/coach.md).

### Fixed — the problem sets' empty columns

- **KodCode now fills every column in the browser.** Difficulty comes from its
  own `gpt_difficulty` rating; the name is the function under test rather than
  the opaque `Algorithm_1_C` id (`running-max-45219-i`), with the id's number
  reported on its own so `sort: q#` orders the corpus; and the cases column is
  read off the literal asserts in its pytest suite, so the runner reports case
  by case instead of pass/fail on the whole module. `lc test --full` still runs
  the module. What its two tags mean — seed family and phrasing style — is now
  documented in the README, in `src/datasets/kodcode.rs`, and in the tab's
  tooltip.
- **Nested columns stored as JSON strings are read.** A Parquet conversion
  stores a structure either as an object or as a string holding the same JSON,
  and only the first spelling was read — which is why DeepSeek LC had no q# or
  tags and Morgan Stanley had no test cases. Both spellings now work.
- **A corpus can no longer index as a single problem.** `task_id` is the index's
  primary key, so rows that slug to the same name silently replaced each other:
  a dump whose rows carry no id and whose statements all open with the same
  words collapsed to one entry. Ids are de-duplicated per file (`-2`, `-3`, …),
  and a row with no title is named after its entry point rather than the first
  words of a boilerplate preamble.
- **Indexing KodCode takes minutes, not hours.** `upsert` deletes a problem's
  old tags by `task_id`, but the tag table's primary key is `(tag, task_id)`, so
  every one of 487k problems scanned the whole tag table. Added the missing
  index. Import also streams the corpus instead of materialising 487k `Problem`s
  in memory, and opening one problem no longer parses the rest of the file.
- **`lc datasets --inspect`** reports what a downloaded corpus actually
  contains: the columns its rows have, which canonical fields came out empty,
  and which columns no adapter reads. It is the answer to "the tags column is
  blank" — the usual cause is a column nothing is mapped to. Values are never
  printed, since a row may hold a reference solution.
- **The workspace header no longer calls every question number a LeetCode
  one** — `question #45219` rather than `LeetCode #45219` on a synthetic corpus.

### Fixed — the tablet layout, and confirming destructive things

- **Coach is a bottom sheet on a tablet again.** Its sheet rules were behind a
  900px media query while the mobile class is set for any coarse pointer up to
  1280px, so an iPad got the class and the desktop panel geometry: the panel
  covered the canvas from the header down while the board was squeezed into the
  strip underneath. One height variable now drives the sheet and the room the
  canvas gives up, and opening it refits the open page.
- **A page is the only thing on the canvas.** Fitting the viewport to one frame
  left its neighbours peeking in, and zooming out brought the whole column back.
  Off-page elements are hidden (`app/src/canvas/pageView.ts`) with their real
  values parked in `customData`, and everything that reads the board — capture,
  thumbnails, `board.json` — sees an unpaged scene. Raster pen ink is clipped to
  the same box.
- **The fit is no longer half the size it asked for.** Excalidraw quantises
  `scrollToContent`'s zoom to 0.1 steps; on a ~3900-unit board an honest 0.19
  floored to 0.1, which is why a page landed as a stamp in the corner.
- **Appearance, the page turner and the zoom cluster share one row** instead of
  the pager floating over them.
- **The text tool places in one tap.** Excalidraw refuses to create a text
  element while another is being edited, so every box after the first cost two
  taps; the press is replayed once its own gesture finishes. The font-size
  slider no longer closes the box on desktop either — a native range input takes
  focus on mousedown, so it drives its own drag.
- **Excalidraw's single-key shortcuts are gone.** `handleKeyboardGlobally` made
  every bare letter live: `1`–`9` and a dozen letters swapped the tool under the
  pen, and `s` / `g` opened the colour pickers that appeared from nowhere.
  Unmodified single-character keys no longer reach it, typing is untouched, and
  a `?` in the toolbar lists what does work.
- **No more `window.confirm`.** Resetting the session and resetting the board
  ask in the app's own modal, and every destructive answer — including
  save-or-discard on leaving — is held for a second like Reveal
  (`app/src/components/HoldButton.tsx`).

### Added — multiple problem sets

- **Four more corpora**, each in its own SQLite tables rather than merged into
  one: [`KodCode-V1`](https://huggingface.co/datasets/KodCode/KodCode-V1),
  [`sft-python-q-problems`](https://huggingface.co/datasets/morganstanley/sft-python-q-problems),
  [`deepseek-leetcode`](https://huggingface.co/datasets/davidheineman/deepseek-leetcode),
  and [`leetcode-with-tests`](https://huggingface.co/datasets/kr4t0n/leetcode-with-tests).
  Separate tables because their ids collide — `two-sum` is in three of them —
  their difficulty scales are unrelated, and rebuilding one must not touch
  another. `src/dataset.rs` is the registry; `src/datasets/` holds one adapter
  per corpus, each documenting its column mapping.
- **A tab strip over the problem table** switches problem sets. Every table and
  session control works the same on any tab; filters reset on a switch, because
  a KodCode tag means nothing in the LeetCode tables. The TUI cycles the same
  choice with `G`.
- **Dataset-qualified progress.** `session.json` keys are now
  `dataset/task_id`, which is what stops a `failed` badge earned in one corpus
  from appearing on the same slug in another. Older session files are migrated
  on load rather than silently losing their history.
- **`lc datasets`**, `--dataset` on `index` / `search` / `random` / `load` /
  `test`, and `data.datasets.<slug>` config for a corpus that lives elsewhere.
- **`scripts/fetch_dataset.py`** converts a Hugging Face Parquet corpus to the
  `.jsonl` the indexer reads. It knows nothing about the schemas on purpose —
  that lives in `src/datasets/` where it is tested.
- **Adapters cannot leak a solution.** They build a `Problem` by hand, so
  serde's redaction guarantee does not cover them; `SOLUTION_FIELDS` lists the
  columns they must not read and a test feeds every adapter a record stuffed
  with marker solutions to prove none escapes.
- **`run_tests.py` runs pytest-style suites** (`test_*` functions, no fixtures),
  which is how KodCode ships its tests. DeepSeek's suite is rewritten at import
  time into the `check(candidate)` the runner calls, and read a second time to
  recover per-case sample I/O.

### Added — test results, and keeping (or dropping) your work

- **Run tests / Submit open a modal** over the board in the Settings panel's
  shell, instead of a card in the coach thread that the next message pushed out
  of sight.
- **Results reach the coach automatically.** The same run is posted into the
  thread as an `app` turn and attached to the next request on its own
  `app_messages` channel, which the daemon tells the model to read as fact —
  unlike everything else on the board, which is a claim the coach should
  question. Asking *"why did case 3 fail?"* needs no copy-paste.
- **Settings → Tests** chooses between running every case and stopping at the
  first failure (`tests.stop_on_first_failure`, off by default: the results
  panel and the coach's counterexample picking both want the whole picture).
- **Leaving a problem asks what to keep** — and asks a different question
  depending on whether it is solved. Unsolved, saving resumes the layout, the
  code, and the coach thread. Solved, the attempt is a record: it is archived
  and the next attempt still starts on a fresh board with a fresh session. The
  coach session is always saved once a problem is solved. Rules and their tests
  live in `src/attempt.rs`; `GET`/`PUT /workspace/:id/agent` and
  `POST /workspace/:id/attempt` are the wire.

### Fixed

- **Draw worked on no vLLM server.** A request carrying `tools` is a 400 unless
  vLLM was started with `--enable-auto-tool-choice` and a `--tool-call-parser`,
  which is not fixable from inside the app — and diagrams are the one coach mode
  built entirely on tool calls. `/coach/viz` now falls back to asking for the
  same calls as JSON, generated from the same schemas. A genuine failure still
  surfaces as itself rather than as a misleading "can't tool-call".
- **Ambient mode is off.** The 60-second loop re-asked itself on slowly-changing
  boards and blocked the pen on local models. The button stays, greyed, behind
  one flag (`AMBIENT_ENABLED`).
- `defaultOpen` on `<details>` is not a React prop, so the reveal bridge's fold
  never actually started open. It is `open`.


### Added — handwriting whiteboard coach

- **`lc` is now a library** (`src/lib.rs`) as well as a binary. `main.rs` swapped
  its `mod` declarations for `use lc::*`; nothing else moved.
- **`lc serve [--port] [--lan]`** — an axum daemon over the existing `index`,
  `loader`, `problem`, `generator`, and `runner` modules, so a tablet can drive
  workspaces that stay on the PC. Loopback by default; `--lan` requires a pairing
  token, generated once and printed as a QR code.
- **Whiteboard coach modes** (`src/llm/coach.rs`):
  - `POST /coach/review` — verdict, ratings, gaps, Socratic question, and a
    counterexample citing one of the problem's **real** sample cases.
  - `WS /coach/session` — 15-second ambient nudges with a server-side escalation
    ladder, so the coach escalates instead of repeating itself.
  - `POST /coach/viz` — diagrams and animations via tool calls.
  - `POST /coach/reveal` — opt-in reference-solution bridge (see below).
- **Cited test cases are verified, not trusted.** The daemon checks a cited index
  against the workspace's cases and overwrites the quoted input/expected with the
  corpus's own text; a fabricated citation is dropped and reported to the client.
- **Per-mode LLM config** — `llm.modes.{ambient,review,bridge,viz}`, each `local`
  or `groq`, so `review` can point at a stronger model while `ambient` stays
  local and cheap.
- **`chat_completions_ex`** — multi-turn calls with tool definitions, image
  parts, and JSON-object output, added alongside the existing
  `chat_completions` so `lc ask` is untouched.
- **`src/reveal.rs`** — the one deliberate exception to the redaction invariant.
  Reading the corpus's `completion` requires a `UserConsent` token that only
  `UserConsent::from_explicit_user_action()` can produce, and the `/coach/reveal`
  handler is the sole caller. Enforced by tests.
- **Reveal tracking** — `session.json` records tap-outs; `lc stats` reports them.
- **`src/coach.rs`** — a `CoachContext` trait (`system_prompt`, `ground_truth`,
  `verify`) with `LeetCodeContext` as the first implementation, so a future
  screen/camera context slots in without touching the canvas or transport.
- **`app/`** — Tauri v2 whiteboard client (React + Excalidraw), with deterministic
  renderers for nine data structures, a frame scrubber, and an ML Kit Digital Ink
  Kotlin plugin for on-device handwriting recognition. See `app/README.md`.
- **Config keys** — `serve.port`, `serve.token`, `llm.modes.*`.

### Added — tablet pass (mobile layout, Android sideload, short-code pairing)

- **Mobile region pages** — on a phone/tablet viewport the board pages through
  one template region at a time (constraints → code → approach → complexity →
  walkthrough) instead of asking for a pan across the whole column. The scene is
  unchanged, so `board.json`, healing and capture are identical to desktop; only
  the viewport moves. Desktop keeps the one wide canvas.
- **Compact mobile chrome** — smaller toolbar and zoom trays, Settings and
  *Open in IDE* behind a ⋯ menu, and Excalidraw's own docks hidden on touch.
- **`POST /pair`** — six-digit session code, generated on every `lc serve --lan`
  start, exchanged once for the long serve token. Pair a tablet by typing Host,
  Port and Code; the QR and token URL remain as a fallback. `GET /pair/code`
  (authenticated) backs Settings → Serve.
- **Android sideload** — `npm run android:init` / `android:apk` apply the
  cleartext-LAN `network_security_config.xml` to the generated Gradle project
  and build a debug-signed APK; `app/README.md` covers Android 12/14 install.

### Fixed

- **`length limit exceeded` on Share/Send** — the daemon's body limit was Axum's
  ~2MB default, which any board PNG exceeded. Now 32MB, with the export
  downscaled before it is sent and the review retried without the image if the
  body is still refused.
- **The coach calling a drawn board blank** — a browser build transcribes no ink,
  so a hand-drawn board arrived with empty `recognized_text` and the coach told
  the student to go implement a solution. The prompt now reads the canvas layout
  and the attached image, and a sparse board gets concrete opening hints instead.
- **Sluggish eraser rendering** — the brush ring updated React state on every
  `pointermove`, re-rendering the board at the pen's sample rate.
- **Pen ink the coach could not see** — the pen draws on the bitmap ink layer,
  not Excalidraw `freedraw`, so `captureStrokes` never saw it and a pen-only
  board submitted as blank. `buildSnapshot` now merges both stroke sources; ink
  the eraser removed is dropped, and a stroke the eraser cut through is split in
  two. Raster ink is repainted into the exported PNG at export scale (with a
  fallback to the ink-less export if bounds drift). Submit no longer rejects a
  legible pen-only board when a vision model will receive the picture.
- **`skeleton_hash` could not detect a skeleton edit** — it was the SHA-256 of
  the whole `solution.py`, taken once at problem load, so it never changed. It
  is now the hash of the skeleton as it currently stands, and a code delta goes
  out only while that still matches what the server acknowledged. Editing an
  import sends the full file, which is what the daemon needs: it refuses a delta
  it cannot anchor rather than reviewing the code it still holds.

### Added — board deltas and the split code editor

- **Server-side board state** (`src/serve/board_session.rs`) — the daemon keeps
  an element baseline per task, applies `board_ops` from the client, and
  reconstructs the full canvas layout before building any prompt. Deltas are a
  transport optimization; the model is never asked to merge them. A twelve-element
  board costs 1897 bytes on the first review and 364 on an unchanged second.
- **`code_mode`** — `unchanged` / `delta` / `full`. An unchanged solution is
  omitted from the review payload entirely.
- **Skeleton / Solution tabs** in the code editor. The entry-point signature and
  everything above it (header, imports, helper classes) is one tab; the method
  body is the other. Both editable — students add imports — and merged back into
  one file for disk. A file that does not match the corpus's `class Solution:`
  shape does not split, and the editor stays a single pane.
- **No-APK tablet paths** documented in `app/README.md`: the browser over the LAN
  (Vite on 1420, pairing to the daemon on 7878) and spacedesk screen mirroring,
  with what each one costs — ML Kit is Android-only, so both fall back to the
  board picture and a vision model.

### Added

- **Interactive TUI** (`lc` with no subcommand) — ASCII banner, menu-driven navigation, WASD controls.
- **Paginated browse** — 15 problems per page with dynamic column widths that fill the terminal.
- **Browse filters** — cycle tag (`T`), difficulty (`E`), sort (`O`); text search (`/`, applies on Enter).
- **Search scope** — matches `task_id` slug, LeetCode `question_id`, and tags (SQL `LIKE`, not per-keystroke reload).
- **Session tracking** — `session.json` records queue, loaded/passed/failed per problem; `lc stats` and TUI session stats.
- **Local submissions** — TUI **Submit locally** writes to SQLite `submissions` table.
- **List management in TUI** — `L` add highlighted problem to list; `R` random add from current filters; **Add to list** in problem actions; create new lists from picker.
- **Bulk corpus support** — index JSON arrays (`train.json`, `test.json`) and `.jsonl`; skip duplicate `.jsonl` when sibling `.json` exists.
- **`lc stats`** — session scope and `--corpus` flag; `lc list stats <name>`.
- **`lc search --sort`** — `question`, `difficulty`, `cases`, `tags`, `task_id`.
- **Editor reuse window** — `load --open` and TUI **Work on problem** use `cursor -r` / `code -r` on `solution.py`.
- **Quiet test runner** for TUI (`cmd_test_quiet`) so test output does not corrupt the terminal UI.
- **`.gitignore`** — excludes `target/`, workspaces, secrets, and local DB artifacts.

### Changed

- Default entry point is the TUI when no subcommand is given.
- **Start session → Browse** opens the paginated table directly (not add-by-id first).
- Replaced `j/k` navigation with **W/S**; selection uses cyan row highlight.
- Removed slow live `/` filter; search now runs one SQL query on Enter with pagination.
- `lists::add_tasks` / `lists::create` split for silent TUI use vs CLI printing.

### Fixed

- Duplicate keystrokes in TUI input (ignore `KeyEventKind::Repeat`; Press-only handling).
- Indexer failure on bulk JSON arrays (`invalid type: map, expected a string`).
- Borrow checker error in `reload_browse_page` when tag filter and count shared a borrow.
- Broken `trunc()` helper that prevented compilation after TUI rewrite.
- Browse table fixed at ~55 columns on wide terminals — now expands `task_id` column to fit.

## [0.1.0] - 2026-07-15

### Added

- Initial Rust CLI: `config`, `index`, `search`, `random`, `load`, `test`, `ask`, `list`.
- SQLite index with tags, difficulty, and full-text slug search.
- Python workspace generation (`README.md`, `solution.py`, `run_tests.py`, `.lc/meta.json`).
- LLM tutor via local OpenAI-compatible servers (Ollama) or Groq.
- Reference solution redaction — `completion` / `response` / `query` never deserialized.
- Named problem lists (create, add, remove, show, shuffle, export, import).
- Incremental indexing by file mtime.

[Unreleased]: https://github.com/amittenak47/leetcode-tui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/amittenak47/leetcode-tui/releases/tag/v0.1.0
