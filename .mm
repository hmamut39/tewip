Stop git add -A sweeping in the commit-message scratch file

PowerShell needs a file on disk to get real line breaks into a commit
message, and that file has now been committed alongside a phase twice -
msg.txt in Phase 50 and .m in Phase 51. Both names are ignored now, so the
next one cannot repeat it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>