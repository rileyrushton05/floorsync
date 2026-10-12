"""Import production data from an uploaded file into the floor's own tables (#297, decision 0020).

`ImportService` runs the workflow. `ImportService.Parsing.read_file` turns the bytes of any
supported format (`formats/`) into one `ImportPlan` before a transaction opens;
`ImportService.import_plan` then judges it (`Validation`, which needs no database) against itself
and the floor (`Persistence`, the only part that reads or writes rows) and writes all of it or
none of it.
"""
