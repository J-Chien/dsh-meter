/**
 * dsh-billing client invariant companion: the client reads the `billing`
 * projection through the standard kit; an absent key is a capability-absent
 * signal (the host unit is not mounted), never a bug.
 */
export {}
