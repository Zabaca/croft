# SERVER_MODE_COPY_COSTLY: server mode would copy a large warehouse at every refresh, so it did not start

Server mode (croft docs server-mode) answers apps from the read copy, so every run that changes data refreshes
the copy. On a filesystem that can clone files (macOS APFS, btrfs, XFS with reflinks) a refresh takes
milliseconds and uses almost no disk. On one that cannot (ext4, the usual Linux filesystem, and most network
shares) it is a plain copy of the whole warehouse: as much disk again as the warehouse, and the run holds its
write lease for the whole copy, because a write during it would tear the copy. Measured on an Apple SSD, a plain
copy of 1 GB took 0.44 s and 1.07 GB of disk, and 5 GB took 1.96 s and 5.35 GB; on a slower disk it is far longer
(about 40 s at 5 GB is an estimate, not a measurement).

So server mode refuses to start where the copy cannot be cloned and the warehouse is over 1 GB, unless the project
accepts the cost. details name the warehouse's size, what each refresh costs, and why the clone failed. The same
check stops the refresh itself, so a warehouse that grows past 1 GB leaves the copy at its last refresh (croft
doctor shows it; .croft/readcopy.log has the reason).

Nothing was written. The warehouse and the read copy are as they were.

What to do: tell the user what it costs (disk and write time at every run) and let them choose:
- keep the project on a filesystem that can clone, which makes the cost vanish; or
- accept it by setting "serverMode": {"enabled": true, "acceptFullCopyCost": true} in croft.json.
Accepting the cost is the user's decision, so ask them first; never set it yourself to make server mode start.
