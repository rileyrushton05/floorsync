"""Operation and ordering operations for the manager-facing API.

An operation is one step inside a job. What a step costs is not stored here -- duration and energy
are properties of the machine that runs it and live on `Compatibility`, managed through the
capability endpoints -- and neither is a sequence position, because ordering is a graph of
`Dependency` edges rather than a column. This package owns both the steps and their ordering.
"""
