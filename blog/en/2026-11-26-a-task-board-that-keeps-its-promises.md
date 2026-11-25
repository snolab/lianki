---
title: "A Task Board That Explains What Is Happening"
date: 2026-11-26
tags: [planning, design, ai]
summary: "Design notes on time estimates, waiting, and progress that stay understandable when several AI helpers are working."
---

# A Task Board That Explains What Is Happening

When several AI helpers are working, a list of task names leaves some basic questions unanswered: What is happening now? What is waiting for me? When should I check again?

We explored a live task list with a Gantt chart—a picture of tasks laid out along a timeline—to make those answers easier to see. These are design notes from that work, rather than a claim that a chart makes estimates accurate. The same ideas can help when planning a study project with several moving parts.

## Give an estimate room to be uncertain

“About 25 minutes” sounds precise, but says little about uncertainty. “Between 12 and 63 minutes” gives the reader a more useful expectation.

We use the labels P5 and P95 for the early and late ends of an estimate. The intention is that about 5% of comparable tasks finish before the early end and about 95% before the late end. A helper's stated range does not establish those probabilities: that requires checking estimates against actual results over time.

For a new task, call the range an estimate. Keep its first estimate and actual completion time so later estimates can be compared with experience. Do not turn a small or mixed collection of tasks into a confident accuracy claim.

Use the late end consistently when deciding that work is overdue. Passing the early end should not trigger a warning.

## Explain a delay before moving the finish time

A changing estimate is useful when it comes with an explanation. Quietly moving the finish time makes the board harder to trust.

Our rule is simple: when work exceeds its estimate, give a reason and a new duration measured from now. “The review found a missing case; another 20 minutes” tells the reader more than a new countdown alone.

A reminder should ask for that update. If no update comes, the board should say that the estimate passed without an explanation. A reminder being delivered is separate from the helper actually responding or finishing the work.

Waiting needs its own treatment. “Waiting for your decision” should name the decision; “blocked on another task” should link that task. Neither should look like active work with a countdown quietly running out. Reminders for a decision can become less frequent while the decision remains unchanged.

## Keep time and completion separate

A timeline bar tells you when work is expected to happen. A completion percentage tells you how much work someone believes is finished. Putting both into the same filled bar makes it easy to confuse elapsed time with completed work.

One arrangement we explored uses a time bar and a separate progress line:

```text
Task          [ planned time ---------------- ]
              completed work -------→
                                  | now
```

Treat a reported percentage as a report, not a measurement of certainty. A task at 90% can still have an unresolved problem that takes longer than the earlier work.

Preserve a faint outline of the first plan when the estimate changes. Use words and symbols as well as colour: “waiting”, “overdue”, and a minus sign remain understandable without distinguishing red from green. Respect reduced-motion settings.

## Show whether an estimate is still being watched

An estimate that has not moved might still be correct, or it might have been forgotten. Let the helper confirm “estimate unchanged” and show when that confirmation happened.

Confirmation should preserve the finish time. After that time has passed, require an explanation and a new estimate instead.

If several tasks are rescheduled together, keep those changes together. The reader should be able to see one decision and its consequences, rather than several apparently unrelated slips.

## Start with a useful view on a small screen

A compact summary can show the next expected result and any decision that needs attention. Open the full timeline only when the reader wants more detail.

On the timeline, keep “now” easy to find. When zooming, the time under the midpoint of the fingers should stay there. When new tasks arrive, keep the row being read in place rather than jumping back to the top.

A linear time axis makes durations easy to compare. A compressed view can fit short tasks and distant work onto one screen, but equal widths then no longer mean equal durations. Make that distinction clear.

Grouping is useful when the list grows. A collapsed parent can summarize its children, but overlapping work should remain visible and the children should be easy to expand. Treat grouping as a design option, not evidence that every view already supports it.

## Keep names short and completion meaningful

Use a short task name followed by a fuller description. A compact view needs a recognizable name; a detail view needs enough context to explain it. Measure available display space rather than assuming every character has the same width.

“Done” should also say what was checked. A draft written, a change reviewed, and a feature seen working are different milestones. Link to the relevant result instead of hiding those distinctions behind 100%.

For a study project, that might mean separating “make the vocabulary list”, “review the examples”, and “try the exercise”. The useful part of the board is the next concrete action it makes visible.

Before trusting a task view, check whether it answers four questions: what is happening, what is waiting, how uncertain is the estimate, and what evidence will count as finished?
