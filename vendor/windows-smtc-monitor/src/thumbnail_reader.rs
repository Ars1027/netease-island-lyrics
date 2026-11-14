use std::io::{Error, ErrorKind, Result};

const CHUNK_SIZE: u32 = 256 * 1024;

/// Accumulate the complete declared stream, never returning a partial image.
pub fn read_thumbnail<F>(size: u64, mut read_chunk: F) -> Result<Vec<u8>>
where
  F: FnMut(u32) -> Result<Vec<u8>>,
{
  let expected = usize::try_from(size)
    .map_err(|_| Error::new(ErrorKind::InvalidData, "Thumbnail length overflows usize"))?;
  let mut bytes = Vec::new();
  bytes.try_reserve_exact(expected)
    .map_err(|_| Error::new(ErrorKind::OutOfMemory, "Cannot allocate thumbnail"))?;
  while bytes.len() < expected {
    let count = (expected - bytes.len()).min(CHUNK_SIZE as usize) as u32;
    let chunk = read_chunk(count)?;
    if chunk.is_empty() {
      return Err(Error::new(ErrorKind::UnexpectedEof, "Incomplete thumbnail stream"));
    }
    if chunk.len() > count as usize {
      return Err(Error::new(ErrorKind::InvalidData, "Thumbnail read exceeds request"));
    }
    bytes.extend_from_slice(&chunk);
  }
  Ok(bytes)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_complete_images_across_the_old_limit() {
    for size in [0, 1, 1_048_575, 1_048_576, 1_048_577, 5_050_859] {
      let original: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
      let mut offset = 0;
      let result = read_thumbnail(size as u64, |requested| {
        let end = offset + requested as usize;
        let data = original[offset..end].to_vec();
        offset = end;
        Ok(data)
      }).unwrap();
      assert_eq!(result, original);
    }
  }

  #[test]
  fn accumulates_short_reads() {
    let mut offset = 0;
    let result = read_thumbnail(100, |requested| {
      let count = requested.min(7) as usize;
      let data = (offset..offset + count).map(|i| i as u8).collect();
      offset += count;
      Ok(data)
    }).unwrap();
    assert_eq!(result, (0..100u8).collect::<Vec<_>>());
  }

  #[test]
  fn rejects_premature_eof_instead_of_returning_partial_artwork() {
    let mut reads = 0;
    let error = read_thumbnail(10, |_| {
      reads += 1;
      Ok(if reads == 1 { vec![1, 2] } else { vec![] })
    }).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::UnexpectedEof);
  }

  #[test]
  fn propagates_failed_reads_and_rejects_excess_data() {
    let error = read_thumbnail(10, |_| Err(Error::new(ErrorKind::Other, "stream failure"))).unwrap_err();
    assert_eq!(error.to_string(), "stream failure");
    assert_eq!(read_thumbnail(1, |_| Ok(vec![1, 2])).unwrap_err().kind(), ErrorKind::InvalidData);
  }
}
