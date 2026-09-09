"""Machine, category and capability operations for the coordinator-facing API.

A machine's capabilities are `Compatibility` rows: which operations it can run, and what each costs
in time and energy when it does. Categories exist only to group machines, so they live here rather
than in a package of their own.
"""
