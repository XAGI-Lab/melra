# Memory research

## Implemented retrieval path

`melra-hybrid-v2` is a deterministic local ranker:

1. tokenize key, value, and tags;
2. compute BM25-style lexical relevance with per-query document frequency;
3. add an exact-phrase signal;
4. weight provenance confidence and freshness;
5. apply maximal-marginal-relevance diversity to the first 20 results;
6. expand the strongest matches to immediately adjacent records when the
   caller supplies an explicit episode ID and sequence;
7. boost records whose explicit speaker is named in the query;
8. exclude expired and superseded records by default.

The score breakdown is returned with every search result. Memory remains
strictly scoped, and values are redacted before persistence. Episode expansion
is bounded to two records in each direction from the first 20 lexical anchors;
records without episode metadata retain the previous retrieval behavior.

Clients can opt into conversational context without changing the value format:

```json
{
  "kind": "memory",
  "action": "put",
  "scope": "workspace",
  "key": "turn-11",
  "value": "Adoption agencies.",
  "speaker": "Alex",
  "episodeId": "conversation-a",
  "sequence": 11
}
```

## LoCoMo objective retrieval

The public harness ingests every dialogue turn as one record and retrieves up
to 100 records per question. Four questions without evidence IDs are excluded.

| Cutoff | Mean evidence coverage | Complete evidence recall |
|---:|---:|---:|
| 5 | `0.590478` | `0.554995` |
| 20 | `0.759652` | `0.716448` |
| 50 | `0.841641` | `0.796670` |
| 100 | `0.888615` | `0.844601` |

Query latency across 1,982 questions was `21.060 ms` p50 and `25.492 ms`
p95 on the recorded machine.

Against the previous public `melra-hybrid-v1` artifact at the same dataset
hash, ingestion unit, and cutoff, coverage@20 improved from `0.629117` to
`0.759652`: a gain of `0.130535` or `20.75%` relative. Complete evidence
recall@20 improved from `0.586276` to `0.716448`. Measured p95 latency
increased by `0.086 ms` (`0.34%`).

This is objective evidence retrieval, not generated-answer accuracy. The
dataset is from the official [LoCoMo repository](https://github.com/snap-research/locomo);
the committed artifact records SHA-256
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.

## Engineering findings

- Scope filtering must happen before ranking; global retrieval followed by
  scope filtering can starve valid results.
- Aggregation questions need a larger evidence budget than single-fact
  questions.
- Granular dialogue turns can use a larger `k` than long documents at the
  same reader-token budget.
- Freshness and supersession must be explicit; overwriting a fact destroys
  history, while returning both old and new facts creates contradictions.
- Diversity should affect the head of the ranking without making deep
  retrieval quadratically expensive.
- A question turn often carries the useful lexical match while its adjacent
  answer turn carries the evidence. Explicit episode order recovers that
  evidence without dataset-specific rules or model calls.
- Speaker identity must be represented as metadata rather than inferred from
  arbitrary value formatting.
- Reader and judge choices can move end-to-end memory scores dramatically,
  which is why this release reports reader-free coverage.

## Next benchmark gates

- official LongMemEval full-500 retrieval run;
- aggregation-aware retrieval depth;
- prompt-injection and memory-poisoning evaluation;
- end-to-end answer accuracy with pinned reader and judge prompts.

Semantic embeddings are no longer a gate: the kernel deliberately ships
model-free retrieval, and a harness that wants vectors indexes what search and
export return ([roadmap](../../ROADMAP.md#memory)).
