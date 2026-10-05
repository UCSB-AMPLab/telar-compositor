-- The last commit whose objects.csv the Compositor has read, apart from
-- head_sha.
--
-- @version v1.5.0-beta
--
-- objects_read_sha: a commit whose objects.csv object rows D1 accounts for.
-- The image upload and the objects commit write objects.csv from D1, so before
-- they write it they compare GitHub's object rows with this commit's, and
-- refuse when GitHub changed one the Compositor has not read. It advances with
-- head_sha, and on its own where only objects.csv was read: the objects sync,
-- and the objects commits themselves. Set here to head_sha, a commit whose
-- every file the Compositor has read; NULL where head_sha is NULL.
ALTER TABLE projects ADD COLUMN objects_read_sha text;
UPDATE projects SET objects_read_sha = head_sha;
