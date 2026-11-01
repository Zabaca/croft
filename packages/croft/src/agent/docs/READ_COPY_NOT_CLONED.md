# READ_COPY_NOT_CLONED: every refresh of the read copy is a full copy of the warehouse (warning)

The read copy (croft docs read-copy, and server mode, croft docs server-mode) is refreshed at the end of every
run that changes data. Where the filesystem can clone files (macOS APFS, btrfs, XFS with reflinks) that takes
milliseconds and almost no disk. This filesystem cannot, so each refresh copies the whole warehouse: as much disk
again as the warehouse (up to twice while a refresh runs), and the run holds its write lease for the whole copy.
details name the warehouse's size, the disk and the seconds a refresh costs (a range; the seconds are an estimate),
and why the clone failed. croft only warns above 100 MB, where a copy starts to matter.

This is the normal case on ext4, the usual Linux filesystem. Nothing is blocked, except that server mode refuses
to start above 1 GB unless the project accepts the cost (SERVER_MODE_COPY_COSTLY).

What to do: nothing, if the disk and the extra write time are acceptable. Otherwise tell the user: keeping the
project on a filesystem that can clone removes the cost, and turning off "readCopy" and "serverMode" in croft.json
removes the copy.
