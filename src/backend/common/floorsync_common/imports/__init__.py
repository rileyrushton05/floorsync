"""Import production data from an uploaded file into the floor's own tables (#297, decision 0020).

A file is read in three steps, each its own module so the first two can be tested without a
database: `formats` turns the bytes of any supported format into one `ImportPlan`, `checks` finds
everything wrong with a plan that the file alone can show, and `service` resolves machine names
against the floor, then writes the whole plan or nothing.
"""
