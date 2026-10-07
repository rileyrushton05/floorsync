"""Import production data from an uploaded file into the floor's own tables (#297, decision 0020).

`ImportService.read_file` turns the bytes of any supported format into one `ImportPlan`, using
`floorsync_file` or `benchmarks`; `checks` finds everything wrong with a plan that the file alone
can show; and `ImportService.import_plan` resolves machine names against the floor, then writes
the whole plan or nothing.
"""
