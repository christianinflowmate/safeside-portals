-- 010_one_line_per_type.sql
--
-- A proposal has at most one line per coverage type, and the database now says so.
--
-- mergeExtractions groups every line across every file by line_type: two files
-- quoting general liability become ONE line with two options, never two lines.
-- That invariant was enforced only by the merge, and materializeProposal's
-- "already materialised?" guard read its count outside the transaction that then
-- did the inserts.
--
-- So two callers racing both saw zero lines and both inserted. That is not
-- hypothetical: the worker materialises as soon as the last extraction lands
-- (jobs/worker.ts materializeIfComplete) and the review screen can POST
-- /materialize at the same moment. The result was a proposal carrying its
-- coverage twice — and since every line's premium is summed into the figure the
-- client is quoted, it doubled the price.
--
-- The guard is now inside the transaction and takes a row lock. This index is the
-- backstop that makes a regression impossible rather than merely unlikely.

-- Any proposal already carrying duplicates keeps its first line of each type.
delete from sp_lines a
 using sp_lines b
 where a.proposal_id = b.proposal_id
   and a.line_type   = b.line_type
   and a.ctid > b.ctid;

create unique index sp_lines_one_per_type on sp_lines(proposal_id, line_type);
