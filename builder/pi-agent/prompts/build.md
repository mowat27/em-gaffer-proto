---
description: Build one slice
argument-hint: "<sliceFile> <title> <context> <sliceId> <attempt> <logbook> <base> <model> <now>"
---

Read `${1:-.slice.json}` in the current directory first: it holds the full slice spec (commands, events, read
models, screens, Given/When/Then specifications) for ${3:-context}/${2:-task}.

Your only job: append exactly one line to `${6:-LOGBOOK.md}` in the form:

    - ${9:-just now} | ${3:-context}/${2:-task} | attempt ${5:-1} | built by pi stub (${8:-the configured model})

Keep every existing line in that file exactly as it is. Do not create, change or delete any other file. Do not
ask questions. When the line is appended, reply with the single word DONE.
