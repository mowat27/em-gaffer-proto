---
description: Build one slice
argument-hint: "<title> <context> <sliceId> <attempt> <logbook> <base> <model> <now> <sliceFile>"
---

Read `${9:-.slice.json}` in the current directory first: it holds the full slice spec (commands, events, read
models, screens, Given/When/Then specifications) for ${2:-context}/${1:-task}.

Your only job: append exactly one line to `${5:-LOGBOOK.md}` in the form:

    - ${8:-just now} | ${2:-context}/${1:-task} | attempt ${4:-1} | built by pi stub (${7:-the configured model})

Keep every existing line in that file exactly as it is. Do not create, change or delete any other file. Do not
ask questions. When the line is appended, reply with the single word DONE.
