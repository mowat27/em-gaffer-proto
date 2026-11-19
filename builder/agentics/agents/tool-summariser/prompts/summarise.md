---
description: Summarise a batch of tool calls in two lines
argument-hint: "<the batch: one line per tool call>"
---

Below is a batch of tool calls an agent made while building a slice, oldest first. Each line is `#<journal seq> <tool>
<input> -> <outcome>: <output>`, with the input and the output cut short.

Write two lines of plain text, nothing else: the first says what the agent did in this batch (name the files,
commands and tools that matter), the second how it went (what worked, what failed and why, or what it is about to
do). No preamble, no lists, no Markdown.

$1
